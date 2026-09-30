import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'

import {
  ChoiceIdSchema,
  DisplayNameSchema,
  HandIdSchema,
  PhaseIdSchema,
  ProposalIdSchema,
  ReadinessIdSchema,
  ReconnectCredentialSchema,
  RevisionSchema,
  RoomCodeSchema,
  RoomIdSchema,
  SessionIdSchema,
  TakeoverIdSchema,
  VisibilitySchema,
  type ChoiceId,
  type CommandError,
  type DisplayName,
  type HandId,
  type LobbySummary,
  type LegalChoice,
  type PhaseId,
  type Proposal,
  type ProposalId,
  type ReadinessId,
  type ReconnectCredential,
  type Revision,
  type RoomCode,
  type RoomEntrySummary,
  type RoomId,
  type RoomSnapshot,
  type Seat,
  type SessionId,
  type TakeoverId,
  type Visibility,
} from '@cg-filipino-mahjong/shared'

import {
  applyEngineAction,
  abortHand,
  getLegalActions,
  initializeHand,
  initializeNextHand,
  type EngineAction,
  type EngineState,
  type EngineTransitionResult,
} from '../game-engine/index.js'
import type {
  BotGameActionInput,
  BotSeatTakeover,
  FourRoomSeats,
  GameActionInput,
  GuestSession,
  PublicLobby,
  ProposalCreateInput,
  ProposalVoteInput,
  RecipientLegalChoices,
  ReconnectTarget,
  RoomExpiration,
  RoomLifecycleTarget,
  RoomSeat,
  RoomSeatController,
  RoomServiceResult,
  RoomStage,
  RoomState,
  SessionAuthentication,
  SessionBootstrap,
  SessionControl,
  SessionDisconnection,
  SessionLifecycleTarget,
} from './model.js'
import { projectRoomSnapshot } from './views.js'

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const DEFAULT_MAX_ROOMS = 100
const DEFAULT_MAX_SESSIONS = 1_000
const DEFAULT_MAX_CODE_ATTEMPTS = 32
const MAX_CONTROLLER_ID_LENGTH = 256

interface SessionRecord {
  readonly sessionId: SessionId
  readonly displayName: DisplayName
  readonly credentialDigest: string
  controllerId: string | null
  roomId: RoomId | null
  roomError?: {
    readonly code: 'room-expired' | 'room-not-found'
    readonly message: string
  }
  readonly lifecycleIdentity: object
}

interface MutableHumanController {
  readonly kind: 'human'
  readonly sessionId: SessionId
  readonly displayName: DisplayName
  connected: boolean
  ready: boolean
}

type MutableController =
  | { readonly kind: 'available' }
  | { readonly kind: 'bot' }
  | MutableHumanController

interface MutableSeat {
  readonly seat: Seat
  controller: MutableController
}

interface MutableProposal {
  readonly proposalId: ProposalId
  readonly kind: 'abort-hand' | 'replace-with-bot'
  readonly proposedBy: Seat
  readonly targetSeat: Seat | null
  readonly eligibleSeats: ReadonlySet<Seat>
  readonly approvals: Set<Seat>
}

interface RoomRecord {
  readonly roomId: RoomId
  readonly roomCode: RoomCode
  visibility: Visibility
  roomRevision: Revision
  readinessId: ReadinessId
  readonly seats: [MutableSeat, MutableSeat, MutableSeat, MutableSeat]
  stage: RoomStage
  choices: Map<Seat, Map<ChoiceId, EngineAction>>
  proposal: MutableProposal | null
  takeoverReservations: MutableTakeoverReservation[]
  readonly spectators: Map<SessionId, { connected: boolean }>
  readonly lifecycleIdentity: object
}

interface MutableTakeoverReservation {
  readonly takeoverId: TakeoverId
  readonly seat: Seat
  readonly sessionId: SessionId
}

export interface RoomServiceOptions {
  readonly maxRooms?: number
  readonly maxSessions?: number
  readonly maxCodeAttempts?: number
  readonly maxExpiredCodes?: number
  readonly createId?: () => string
  readonly createCredential?: () => string
  readonly createRoomCode?: () => string
  readonly initializeHand?: () => EngineTransitionResult
  readonly initializeNextHand?: (previousHand: EngineState) => EngineTransitionResult
  readonly createChoiceId?: () => string
  readonly createProposalId?: () => string
  readonly createTakeoverId?: () => string
}

function accepted<T>(value: T, detachedSessionIds: Iterable<SessionId> = []): RoomServiceResult<T> {
  return { ok: true, value, detachedSessionIds: Object.freeze([...new Set(detachedSessionIds)]) }
}

function rejected<T>(
  code: CommandError['code'],
  message: string,
  details?: CommandError['details'],
): RoomServiceResult<T> {
  return { ok: false, error: details ? { code, message, details } : { code, message } }
}

function credentialDigest(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('base64url')
}

function defaultRoomCode(): string {
  return Array.from(randomBytes(6), (value) => ROOM_CODE_ALPHABET[value & 31]).join('')
}

function validLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive safe integer.`)
  return resolved
}

function parseControllerId(controllerId: string): RoomServiceResult<string> {
  if (typeof controllerId !== 'string' || controllerId.length < 1 || controllerId.length > MAX_CONTROLLER_ID_LENGTH) {
    return rejected('invalid-controller', 'The controller identifier is invalid.')
  }
  return accepted(controllerId)
}

function immutableController(controller: MutableController): RoomSeatController {
  if (controller.kind !== 'human') return Object.freeze({ kind: controller.kind })
  return Object.freeze({
    kind: 'human',
    sessionId: controller.sessionId,
    displayName: controller.displayName,
    connected: controller.connected,
    ready: controller.ready,
  })
}

function immutableSeats(seats: RoomRecord['seats']): FourRoomSeats {
  return Object.freeze(seats.map((entry): RoomSeat => Object.freeze({
    seat: entry.seat,
    controller: immutableController(entry.controller),
  })) as unknown as FourRoomSeats)
}

function immutableStage(stage: RoomStage): RoomStage {
  if (stage.kind === 'waiting') return Object.freeze({ kind: 'waiting' })
  return Object.freeze({ ...stage })
}

function immutableProposal(proposal: MutableProposal | null): Proposal | null {
  if (!proposal) return null
  const votes: Proposal['votes'] = [...proposal.eligibleSeats]
    .sort((left, right) => left - right)
    .map((seat) => ({
      seat,
      status: proposal.approvals.has(seat) ? 'approved' : 'pending',
    }))
  return Object.freeze({
    proposalId: proposal.proposalId,
    kind: proposal.kind,
    proposedBy: proposal.proposedBy,
    targetSeat: proposal.targetSeat,
    votes,
  })
}

function immutableRoom(room: RoomRecord): RoomState {
  return Object.freeze({
    roomId: room.roomId,
    roomCode: room.roomCode,
    visibility: room.visibility,
    roomRevision: room.roomRevision,
    readinessId: room.readinessId,
    spectatorCount: [...room.spectators.values()].filter((spectator) => spectator.connected).length,
    seats: immutableSeats(room.seats),
    stage: immutableStage(room.stage),
    proposal: immutableProposal(room.proposal),
    takeoverReservations: Object.freeze(room.takeoverReservations.map((reservation) => Object.freeze({
      takeoverId: reservation.takeoverId,
      seat: reservation.seat,
      sessionId: reservation.sessionId,
    }))),
  })
}

function immutableSession(session: SessionRecord): GuestSession {
  return Object.freeze({
    sessionId: session.sessionId,
    displayName: session.displayName,
    roomId: session.roomId,
    hasActiveController: session.controllerId !== null,
  })
}

function nextRevision(revision: Revision): Revision {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Room revision is exhausted.')
  return revision + 1
}

function publicChoice(choiceId: ChoiceId, action: EngineAction): LegalChoice {
  if (action.kind === 'discard') return { choiceId, kind: 'discard', tileId: action.tileId }
  if (action.kind === 'win') {
    return { choiceId, kind: 'win', source: 'self-draw' }
  }
  if (action.kind === 'secret') {
    return { choiceId, kind: 'secret', concealedTileIds: [...action.concealedTileIds] }
  }
  if (action.kind === 'sagasa') {
    return { choiceId, kind: 'sagasa', meldId: action.meldId, tileId: action.tileId }
  }
  const choice = action.choice
  if (choice.kind === 'pass') return { choiceId, kind: 'pass' }
  if (choice.kind === 'win') return { choiceId, kind: 'win', source: 'discard' }
  if (choice.kind === 'open-kang') {
    return { choiceId, kind: 'open-kang', concealedTileIds: [...choice.concealedTileIds] }
  }
  return { choiceId, kind: choice.kind, concealedTileIds: [...choice.concealedTileIds] }
}

function commandMatchesChoice(kind: GameActionInput['action']['kind'], action: EngineAction): boolean {
  if (kind === 'respond-to-discard') return action.kind === 'respond-to-discard'
  return kind === action.kind
}

export class RoomService {
  readonly #maxRooms: number
  readonly #maxSessions: number
  readonly #maxCodeAttempts: number
  readonly #maxExpiredCodes: number
  readonly #createId: () => string
  readonly #createCredential: () => string
  readonly #createRoomCode: () => string
  readonly #initializeHand: () => EngineTransitionResult
  readonly #initializeNextHand: (previousHand: EngineState) => EngineTransitionResult
  readonly #createChoiceId: () => string
  readonly #createProposalId: () => string
  readonly #createTakeoverId: () => string
  readonly #sessions = new Map<SessionId, SessionRecord>()
  readonly #sessionsByCredentialDigest = new Map<string, SessionRecord>()
  readonly #sessionsByController = new Map<string, SessionRecord>()
  readonly #rooms = new Map<RoomId, RoomRecord>()
  readonly #roomsByCode = new Map<RoomCode, RoomRecord>()
  readonly #expiredCodes = new Set<RoomCode>()

  constructor(options: RoomServiceOptions = {}) {
    this.#maxRooms = validLimit(options.maxRooms, DEFAULT_MAX_ROOMS, 'maxRooms')
    this.#maxSessions = validLimit(options.maxSessions, DEFAULT_MAX_SESSIONS, 'maxSessions')
    this.#maxCodeAttempts = validLimit(options.maxCodeAttempts, DEFAULT_MAX_CODE_ATTEMPTS, 'maxCodeAttempts')
    this.#maxExpiredCodes = validLimit(options.maxExpiredCodes, this.#maxRooms, 'maxExpiredCodes')
    this.#createId = options.createId ?? randomUUID
    this.#createCredential = options.createCredential ?? (() => randomBytes(32).toString('base64url'))
    this.#createRoomCode = options.createRoomCode ?? defaultRoomCode
    this.#initializeHand = options.initializeHand ?? initializeHand
    this.#initializeNextHand = options.initializeNextHand ?? initializeNextHand
    this.#createChoiceId = options.createChoiceId ?? randomUUID
    this.#createProposalId = options.createProposalId ?? randomUUID
    this.#createTakeoverId = options.createTakeoverId ?? randomUUID
  }

  bootstrapSession(displayNameInput: unknown, controllerIdInput: string): RoomServiceResult<SessionBootstrap> {
    const displayName = DisplayNameSchema.safeParse(displayNameInput)
    if (!displayName.success) return rejected('validation-error', 'The display name is invalid.')
    const controllerId = parseControllerId(controllerIdInput)
    if (!controllerId.ok) return controllerId
    if (this.#sessionsByController.has(controllerId.value)) {
      return rejected('invalid-controller', 'The controller already belongs to another session.')
    }
    if (this.#sessions.size >= this.#maxSessions) {
      return rejected('rate-limited', 'The guest session limit has been reached.')
    }

    const sessionId = this.#newId(SessionIdSchema, 'session')
    if (!sessionId.ok) return sessionId
    const credential = this.#newCredential()
    if (!credential.ok) return credential
    const digest = credentialDigest(credential.value)
    const session: SessionRecord = {
      sessionId: sessionId.value,
      displayName: displayName.data,
      credentialDigest: digest,
      controllerId: controllerId.value,
      roomId: null,
      lifecycleIdentity: {},
    }
    this.#sessions.set(session.sessionId, session)
    this.#sessionsByCredentialDigest.set(digest, session)
    this.#sessionsByController.set(controllerId.value, session)
    return accepted(Object.freeze({
      session: immutableSession(session),
      control: Object.freeze({ sessionId: session.sessionId, controllerId: controllerId.value }),
      reconnectCredential: credential.value,
    }))
  }

  resolveReconnectTarget(reconnectCredentialInput: unknown): RoomServiceResult<ReconnectTarget> {
    const credential = ReconnectCredentialSchema.safeParse(reconnectCredentialInput)
    if (!credential.success) return rejected('invalid-session', 'The reconnect credential is invalid.')
    const session = this.#sessionsByCredentialDigest.get(credentialDigest(credential.data))
    if (!session) return rejected('invalid-session', 'The reconnect credential is invalid.')
    return accepted(Object.freeze({ sessionId: session.sessionId, roomId: session.roomId }))
  }

  authenticate(reconnectCredentialInput: unknown, controllerIdInput: string): RoomServiceResult<SessionAuthentication> {
    const credential = ReconnectCredentialSchema.safeParse(reconnectCredentialInput)
    if (!credential.success) return rejected('invalid-session', 'The reconnect credential is invalid.')
    const controllerId = parseControllerId(controllerIdInput)
    if (!controllerId.ok) return controllerId
    const session = this.#sessionsByCredentialDigest.get(credentialDigest(credential.data))
    if (!session) return rejected('invalid-session', 'The reconnect credential is invalid.')
    const controllerOwner = this.#sessionsByController.get(controllerId.value)
    if (controllerOwner && controllerOwner !== session) {
      return rejected('invalid-controller', 'The controller already belongs to another session.')
    }

    const room = session.roomId === null ? null : this.#rooms.get(session.roomId) ?? null
    const human = room ? this.#humanSeatForSession(room, session.sessionId) : null
    const spectator = room?.spectators.get(session.sessionId)
    const controllerChanged = session.controllerId !== controllerId.value
    const replacementWindow = human && controllerChanged && room?.stage.kind === 'playing'
      ? this.#createPhaseWindow(room.stage.engineState)
      : null
    if (replacementWindow && !replacementWindow.ok) return replacementWindow

    const supersededControllerId = session.controllerId !== null && session.controllerId !== controllerId.value
      ? session.controllerId
      : null
    if (supersededControllerId !== null) this.#sessionsByController.delete(supersededControllerId)
    session.controllerId = controllerId.value
    this.#sessionsByController.set(controllerId.value, session)
    if (room) {
      if (replacementWindow?.ok && room.stage.kind === 'playing') {
        room.stage = { ...room.stage, phaseId: replacementWindow.value.phaseId }
        room.choices = replacementWindow.value.choices
      }
      if (human && !human.controller.connected) {
        room.proposal = null
        human.controller.connected = true
        room.roomRevision = nextRevision(room.roomRevision)
        this.#startReadyRoom(room)
      } else if (replacementWindow?.ok) {
        room.roomRevision = nextRevision(room.roomRevision)
      }
      if (spectator && !spectator.connected) {
        spectator.connected = true
        room.roomRevision = nextRevision(room.roomRevision)
      }
    }
    const detachedFromMissingRoom = room === null && session.roomId !== null
    if (detachedFromMissingRoom) {
      session.roomId = null
      session.roomError = { code: 'room-not-found', message: 'The room was not found.' }
    }

    const roomError = session.roomError
    delete session.roomError
    return accepted(Object.freeze({
      session: immutableSession(session),
      control: Object.freeze({ sessionId: session.sessionId, controllerId: controllerId.value }),
      supersededControllerId,
      room: room ? immutableRoom(room) : null,
      ...(roomError ? { roomError: Object.freeze({ ...roomError }) } : {}),
    }), detachedFromMissingRoom ? [session.sessionId] : [])
  }

  disconnect(control: SessionControl): RoomServiceResult<SessionDisconnection> {
    const session = this.#sessions.get(control.sessionId)
    if (!session || session.controllerId !== control.controllerId) {
      return accepted(Object.freeze({ disconnected: false, room: null }))
    }
    const room = session.roomId === null ? null : this.#rooms.get(session.roomId) ?? null
    const human = room ? this.#humanSeatForSession(room, session.sessionId) : null
    const spectator = room?.spectators.get(session.sessionId)
    const replacementWindow = human?.controller.connected && room?.stage.kind === 'playing'
      ? this.#createPhaseWindow(room.stage.engineState)
      : null
    if (replacementWindow && !replacementWindow.ok) return replacementWindow
    this.#sessionsByController.delete(control.controllerId)
    session.controllerId = null
    const detachedSessionIds = new Set<SessionId>()
    if (room) {
      if (human && human.controller.connected) {
        room.proposal = null
        human.controller.connected = false
        if (replacementWindow?.ok && room.stage.kind === 'playing') {
          room.stage = { ...room.stage, phaseId: replacementWindow.value.phaseId }
          room.choices = replacementWindow.value.choices
        }
        room.roomRevision = nextRevision(room.roomRevision)
      } else if (spectator) {
        const wasConnected = spectator.connected
        spectator.connected = false
        const reservationIndex = room.takeoverReservations.findIndex(
          (reservation) => reservation.sessionId === session.sessionId,
        )
        if (reservationIndex >= 0) room.takeoverReservations.splice(reservationIndex, 1)
        if (wasConnected || reservationIndex >= 0) room.roomRevision = nextRevision(room.roomRevision)
      } else {
        const reservationIndex = room.takeoverReservations.findIndex(
          (reservation) => reservation.sessionId === session.sessionId,
        )
        if (reservationIndex >= 0) {
          room.takeoverReservations.splice(reservationIndex, 1)
          session.roomId = null
          detachedSessionIds.add(session.sessionId)
          room.roomRevision = nextRevision(room.roomRevision)
        }
      }
    }
    return accepted(
      Object.freeze({ disconnected: true, room: room ? immutableRoom(room) : null }),
      detachedSessionIds,
    )
  }

  listPublicRooms(control: SessionControl): RoomServiceResult<PublicLobby> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const rooms = [...this.#rooms.values()]
      .filter((room) => room.visibility === 'public')
      .map((room) => this.#lobbySummary(room))
    return accepted(Object.freeze({ rooms: Object.freeze(rooms) }))
  }

  inspectRoom(control: SessionControl, roomCodeInput: unknown): RoomServiceResult<RoomEntrySummary> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const roomCode = RoomCodeSchema.safeParse(roomCodeInput)
    if (!roomCode.success) return rejected('room-not-found', 'The room code is invalid or unknown.')
    const room = this.#roomsByCode.get(roomCode.data)
    if (!room) {
      return this.#expiredCodes.has(roomCode.data)
        ? rejected('room-expired', 'The room has expired.')
        : rejected('room-not-found', 'The room was not found.')
    }
    if (authorization.value.roomId !== null && (
      authorization.value.roomId !== room.roomId || !room.spectators.has(authorization.value.sessionId)
    )) return rejected('already-seated', 'The session is already attached to a room.')
    return accepted(this.#roomEntrySummary(room))
  }

  spectateRoom(control: SessionControl, roomCodeInput: unknown): RoomServiceResult<RoomState> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const roomCode = RoomCodeSchema.safeParse(roomCodeInput)
    if (!roomCode.success) return rejected('room-not-found', 'The room code is invalid or unknown.')
    const room = this.#roomsByCode.get(roomCode.data)
    if (!room) {
      return this.#expiredCodes.has(roomCode.data)
        ? rejected('room-expired', 'The room has expired.')
        : rejected('room-not-found', 'The room was not found.')
    }

    const session = authorization.value
    const existingSpectator = room.spectators.get(session.sessionId)
    if (session.roomId !== null) {
      if (session.roomId === room.roomId && existingSpectator) {
        return accepted(immutableRoom(room))
      }
      return rejected('already-seated', 'The session is already attached to a room.')
    }
    if (existingSpectator) return rejected('internal-error', 'The spectator membership is inconsistent.')

    room.spectators.set(session.sessionId, { connected: true })
    session.roomId = room.roomId
    delete session.roomError
    room.roomRevision = nextRevision(room.roomRevision)
    return accepted(immutableRoom(room))
  }

  getControlledRoom(control: SessionControl): RoomServiceResult<RoomState | null> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    if (authorization.value.roomId === null) return accepted(null)
    const room = this.#rooms.get(authorization.value.roomId)
    return accepted(room ? immutableRoom(room) : null)
  }

  resolveRoomId(roomCodeInput: unknown): RoomServiceResult<RoomId> {
    const roomCode = RoomCodeSchema.safeParse(roomCodeInput)
    if (!roomCode.success) return rejected('room-not-found', 'The room code is invalid or unknown.')
    const room = this.#roomsByCode.get(roomCode.data)
    if (room) return accepted(room.roomId)
    return this.#expiredCodes.has(roomCode.data)
      ? rejected('room-expired', 'The room has expired.')
      : rejected('room-not-found', 'The room was not found.')
  }

  getRoom(control: SessionControl, roomIdInput: unknown): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, roomIdInput)
    return access.ok ? accepted(immutableRoom(access.value.room)) : access
  }

  getRecipientSnapshot(control: SessionControl, roomIdInput: unknown): RoomServiceResult<RoomSnapshot> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    const reservation = access.value.room.takeoverReservations.find(
      (candidate) => candidate.sessionId === access.value.session.sessionId,
    )
    const spectator = access.value.room.spectators.has(access.value.session.sessionId)
    if (!human && !reservation && !spectator) return rejected('not-seated', 'The session does not control a room seat.')
    const choices = human ? this.#publicChoicesForSeat(access.value.room, human.seat) : []
    const recipientRole = human ? 'player' : spectator ? 'spectator' : 'pending-takeover'
    try {
      return accepted(projectRoomSnapshot(
        immutableRoom(access.value.room),
        human?.seat ?? null,
        choices,
        access.value.session.sessionId,
        recipientRole,
      ))
    } catch {
      return rejected('internal-error', 'The room snapshot could not be projected.')
    }
  }

  getBotDecisionSnapshot(roomIdInput: unknown, seatInput: unknown): RoomServiceResult<RoomSnapshot> {
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    if (!Number.isInteger(seatInput) || ![0, 1, 2, 3].includes(seatInput as number)) {
      return rejected('validation-error', 'The seat is invalid.')
    }
    const seat = seatInput as Seat
    if (room.seats[seat].controller.kind !== 'bot') {
      return rejected('invalid-controller', 'The seat is not controlled by a bot.')
    }
    if (room.stage.kind !== 'playing') return rejected('invalid-room-state', 'The room has no active hand.')
    try {
      return accepted(projectRoomSnapshot(immutableRoom(room), seat, this.#publicChoicesForSeat(room, seat)))
    } catch {
      return rejected('internal-error', 'The bot decision snapshot could not be projected.')
    }
  }

  getLegalChoices(control: SessionControl, roomIdInput: unknown): RoomServiceResult<RecipientLegalChoices> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const stage = access.value.room.stage
    if (stage.kind !== 'playing') return rejected('invalid-room-state', 'The room has no active hand.')
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human) return rejected('not-seated', 'The session does not control a room seat.')
    const choices = this.#publicChoicesForSeat(access.value.room, human.seat)
    return accepted(Object.freeze({
      handId: stage.handId,
      phaseId: stage.phaseId,
      gameRevision: stage.gameRevision,
      choices: Object.freeze(choices),
    }))
  }

  #publicChoicesForSeat(room: RoomRecord, seat: Seat): readonly LegalChoice[] {
    if (room.stage.kind !== 'playing') return []
    return [...(room.choices.get(seat)?.entries() ?? [])]
      .map(([choiceId, action]) => Object.freeze(publicChoice(choiceId, action)))
  }

  applyGameAction(control: SessionControl, input: GameActionInput): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, input.roomId)
    if (!access.ok) return access
    const room = access.value.room
    const human = this.#humanSeatForSession(room, access.value.session.sessionId)
    if (!human || !human.controller.connected) {
      return rejected('invalid-controller', 'The session does not control a connected room seat.')
    }
    return this.#applySeatGameAction(
      room,
      human.seat,
      input.handId,
      input.phaseId,
      input.action.choiceId,
      input.action.kind,
    )
  }

  applyBotGameAction(input: BotGameActionInput): RoomServiceResult<RoomState> {
    const roomId = RoomIdSchema.safeParse(input.roomId)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    if (!Number.isInteger(input.seat) || ![0, 1, 2, 3].includes(input.seat)) {
      return rejected('validation-error', 'The seat is invalid.')
    }
    if (room.seats[input.seat].controller.kind !== 'bot') {
      return rejected('invalid-controller', 'The seat is not controlled by a bot.')
    }
    if (!room.seats.some((seat) => seat.controller.kind === 'human' && seat.controller.connected)) {
      return rejected('room-paused', 'Bot execution requires at least one connected human.')
    }
    return this.#applySeatGameAction(room, input.seat, input.handId, input.phaseId, input.choiceId)
  }

  #applySeatGameAction(
    room: RoomRecord,
    seat: Seat,
    handId: HandId,
    phaseId: PhaseId,
    choiceId: ChoiceId,
    expectedKind?: GameActionInput['action']['kind'],
  ): RoomServiceResult<RoomState> {
    const stage = room.stage
    if (stage.kind === 'between-hands') {
      const details = {
        roomId: room.roomId,
        currentRoomRevision: room.roomRevision,
        currentHandId: stage.handId,
      }
      return handId === stage.handId
        ? rejected('stale-phase', 'The action phase has already resolved.', details)
        : rejected('stale-hand', 'The hand has changed.', details)
    }
    if (stage.kind !== 'playing') return rejected('invalid-room-state', 'The room has no active hand.')
    const freshnessDetails = {
      roomId: room.roomId,
      currentRoomRevision: room.roomRevision,
      currentHandId: stage.handId,
      currentPhaseId: stage.phaseId,
    }
    if (handId !== stage.handId) {
      return rejected('stale-hand', 'The hand has changed.', freshnessDetails)
    }
    if (phaseId !== stage.phaseId) {
      return rejected('stale-phase', 'The action phase has changed.', freshnessDetails)
    }
    if (room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected)) {
      return rejected('room-paused', 'The room is paused while a human controller is disconnected.', freshnessDetails)
    }
    if (
      stage.engineState.phase.kind === 'discard-responses'
      && stage.engineState.phase.responses.some((response) => response.seat === seat)
    ) {
      return rejected('already-responded', 'This seat has already submitted its final response.', freshnessDetails)
    }
    const action = room.choices.get(seat)?.get(choiceId)
    if (!action || (expectedKind !== undefined && !commandMatchesChoice(expectedKind, action))) {
      return rejected('action-not-legal', 'The selected action is not legal in the current phase.', freshnessDetails)
    }

    const transitioned = applyEngineAction(stage.engineState, action)
    if (!transitioned.accepted) {
      const code = transitioned.error.code === 'out-of-turn'
        && stage.engineState.phase.kind === 'discard-responses'
        ? 'already-responded'
        : 'action-not-legal'
      return rejected(code, transitioned.error.message, freshnessDetails)
    }

    const gameRevision = nextRevision(stage.gameRevision)
    if (transitioned.state.phase.kind === 'ended') {
      const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
      if (!readinessId.ok) return readinessId
      room.stage = {
        kind: 'between-hands',
        handId: stage.handId,
        gameRevision,
        engineState: transitioned.state,
      }
      room.choices = new Map()
      const detachedSessionIds = this.#commitPendingTakeovers(room)
      this.#resetReadiness(room, readinessId.value)
      return accepted(immutableRoom(room), detachedSessionIds)
    }

    const remainsOpenResponse = action.kind === 'respond-to-discard'
      && stage.engineState.phase.kind === 'discard-responses'
      && transitioned.state.phase.kind === 'discard-responses'
      && transitioned.state.phase.discardTileId === stage.engineState.phase.discardTileId
    let detachedSessionIds: readonly SessionId[] = []
    if (remainsOpenResponse) {
      room.stage = { ...stage, gameRevision, engineState: transitioned.state }
      room.choices.delete(seat)
    } else {
      const window = this.#createPhaseWindow(transitioned.state)
      if (!window.ok) return window
      room.stage = {
        kind: 'playing',
        handId: stage.handId,
        phaseId: window.value.phaseId,
        gameRevision,
        engineState: transitioned.state,
      }
      room.choices = window.value.choices
      if (stage.engineState.phase.kind === 'discard-responses') {
        detachedSessionIds = this.#commitPendingTakeovers(room)
      }
    }
    room.roomRevision = nextRevision(room.roomRevision)
    return accepted(immutableRoom(room), detachedSessionIds)
  }

  createRoom(control: SessionControl, visibilityInput: unknown): RoomServiceResult<RoomState> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const visibility = VisibilitySchema.safeParse(visibilityInput)
    if (!visibility.success) return rejected('validation-error', 'The room visibility is invalid.')
    if (authorization.value.roomId !== null) return rejected('already-seated', 'The session is already seated in a room.')
    if (this.#rooms.size >= this.#maxRooms) return rejected('rate-limited', 'The active room limit has been reached.')

    const roomId = this.#newId(RoomIdSchema, 'room')
    if (!roomId.ok) return roomId
    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    const roomCode = this.#newRoomCode()
    if (!roomCode.ok) return roomCode
    const human = this.#newHumanController(authorization.value)
    const room: RoomRecord = {
      roomId: roomId.value,
      roomCode: roomCode.value,
      visibility: visibility.data,
      roomRevision: 0,
      readinessId: readinessId.value,
      seats: [
        { seat: 0, controller: human },
        { seat: 1, controller: { kind: 'available' } },
        { seat: 2, controller: { kind: 'available' } },
        { seat: 3, controller: { kind: 'available' } },
      ],
      stage: { kind: 'waiting' },
      choices: new Map(),
      proposal: null,
      takeoverReservations: [],
      spectators: new Map(),
      lifecycleIdentity: {},
    }
    authorization.value.roomId = room.roomId
    delete authorization.value.roomError
    this.#rooms.set(room.roomId, room)
    this.#roomsByCode.set(room.roomCode, room)
    this.#expiredCodes.delete(room.roomCode)
    return accepted(immutableRoom(room))
  }

  joinRoom(control: SessionControl, roomCodeInput: unknown): RoomServiceResult<RoomState> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const roomCode = RoomCodeSchema.safeParse(roomCodeInput)
    if (!roomCode.success) return rejected('room-not-found', 'The room code is invalid or unknown.')
    const room = this.#roomsByCode.get(roomCode.data)
    if (!room) {
      return this.#expiredCodes.has(roomCode.data)
        ? rejected('room-expired', 'The room has expired.')
        : rejected('room-not-found', 'The room was not found.')
    }
    const session = authorization.value
    const isSpectator = room.spectators.has(session.sessionId)
    const pendingTakeover = room.takeoverReservations.some((reservation) => reservation.sessionId === session.sessionId)
    if (session.roomId !== null && !(session.roomId === room.roomId && isSpectator)) {
      return pendingTakeover
        ? rejected('takeover-pending', 'The session already has a pending bot-seat takeover.')
        : rejected('already-seated', 'The session is already seated in a room.')
    }
    if (pendingTakeover) return rejected('takeover-pending', 'The pending takeover must resolve before joining an open seat.')
    if (room.stage.kind !== 'waiting' && room.stage.kind !== 'between-hands') {
      return rejected('invalid-room-state', 'The room is already playing.')
    }
    const seat = room.seats.find((candidate) => candidate.controller.kind === 'available')
    if (!seat) return rejected('room-full', 'The room has no available human seat.')

    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    room.proposal = null
    seat.controller = this.#newHumanController(session)
    room.spectators.delete(session.sessionId)
    session.roomId = room.roomId
    delete session.roomError
    this.#resetReadiness(room, readinessId.value)
    return accepted(immutableRoom(room))
  }

  requestBotSeatTakeover(
    control: SessionControl,
    roomCodeInput: unknown,
    seatInput: unknown,
  ): RoomServiceResult<BotSeatTakeover> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const roomCode = RoomCodeSchema.safeParse(roomCodeInput)
    if (!roomCode.success) return rejected('room-not-found', 'The room code is invalid or unknown.')
    const room = this.#roomsByCode.get(roomCode.data)
    if (!room) {
      return this.#expiredCodes.has(roomCode.data)
        ? rejected('room-expired', 'The room has expired.')
        : rejected('room-not-found', 'The room was not found.')
    }
    const session = authorization.value
    const isSpectator = room.spectators.has(session.sessionId)
    const ownReservation = room.takeoverReservations.some((reservation) => reservation.sessionId === session.sessionId)
    if (ownReservation) return rejected('takeover-pending', 'The session already has a pending bot-seat takeover.')
    if (session.roomId !== null && !(session.roomId === room.roomId && isSpectator)) {
      return rejected('already-seated', 'The session is already seated in a room.')
    }
    if (!Number.isInteger(seatInput) || ![0, 1, 2, 3].includes(seatInput as number)) {
      return rejected('validation-error', 'The seat is invalid.')
    }
    const seat = room.seats[seatInput as Seat]
    if (seat.controller.kind !== 'bot') {
      return rejected('seat-unavailable', 'Only a bot-controlled seat can be taken over.')
    }
    if (room.takeoverReservations.some((reservation) => reservation.seat === seat.seat)) {
      return rejected('takeover-pending', 'Another guest already has a pending takeover for this seat.')
    }

    if (room.stage.kind === 'playing' && room.stage.engineState.phase.kind === 'discard-responses') {
      const takeoverId = this.#newTakeoverId()
      if (!takeoverId.ok) return takeoverId
      session.roomId = room.roomId
      delete authorization.value.roomError
      room.takeoverReservations.push({
        takeoverId: takeoverId.value,
        seat: seat.seat,
        sessionId: authorization.value.sessionId,
      })
      room.roomRevision = nextRevision(room.roomRevision)
      return accepted(Object.freeze({
        kind: 'pending',
        takeoverId: takeoverId.value,
        room: immutableRoom(room),
      }))
    }

    const readinessId = this.#isPreHand(room)
      ? this.#newId(ReadinessIdSchema, 'readiness')
      : null
    if (readinessId && !readinessId.ok) return readinessId
    session.roomId = room.roomId
    delete authorization.value.roomError
    room.proposal = null
    seat.controller = this.#newHumanController(session)
    room.spectators.delete(session.sessionId)
    if (readinessId?.ok) {
      this.#resetReadiness(room, readinessId.value)
    } else {
      room.roomRevision = nextRevision(room.roomRevision)
    }
    return accepted(Object.freeze({ kind: 'committed', room: immutableRoom(room) }))
  }

  setVisibility(
    control: SessionControl,
    roomIdInput: unknown,
    expectedRevisionInput: unknown,
    visibilityInput: unknown,
  ): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human || !human.controller.connected) {
      return rejected('invalid-controller', 'Only a connected seated human can change room visibility.')
    }
    const freshness = this.#expectRevision(access.value.room, expectedRevisionInput)
    if (!freshness.ok) return freshness
    const visibility = VisibilitySchema.safeParse(visibilityInput)
    if (!visibility.success) return rejected('validation-error', 'The room visibility is invalid.')
    if (!this.#isPreHand(access.value.room)) return rejected('invalid-room-state', 'Visibility can change only between hands.')
    if (access.value.room.visibility !== visibility.data) {
      access.value.room.visibility = visibility.data
      access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
    }
    return accepted(immutableRoom(access.value.room))
  }

  configureSeat(
    control: SessionControl,
    roomIdInput: unknown,
    expectedRevisionInput: unknown,
    seatInput: unknown,
    controller: 'available' | 'bot',
  ): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human || !human.controller.connected) {
      return rejected('invalid-controller', 'Only a connected seated human can configure seats.')
    }
    const freshness = this.#expectRevision(access.value.room, expectedRevisionInput)
    if (!freshness.ok) return freshness
    if (!this.#isPreHand(access.value.room)) return rejected('invalid-room-state', 'Seats can change only between hands.')
    if (controller !== 'available' && controller !== 'bot') return rejected('validation-error', 'The seat controller is invalid.')
    if (!Number.isInteger(seatInput) || ![0, 1, 2, 3].includes(seatInput as number)) {
      return rejected('validation-error', 'The seat is invalid.')
    }
    const seat = access.value.room.seats[seatInput as Seat]
    if (seat.controller.kind === 'human') return rejected('seat-unavailable', 'A human-controlled seat cannot be configured.')
    if (seat.controller.kind !== controller) {
      const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
      if (!readinessId.ok) return readinessId
      seat.controller = { kind: controller }
      this.#resetReadiness(access.value.room, readinessId.value)
    }
    return accepted(immutableRoom(access.value.room))
  }

  setReady(
    control: SessionControl,
    roomIdInput: unknown,
    readinessIdInput: unknown,
    ready: boolean,
  ): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human || !human.controller.connected) return rejected('invalid-controller', 'The session does not control a connected room seat.')
    if (!this.#isPreHand(access.value.room)) return rejected('invalid-room-state', 'Readiness can change only between hands.')
    const readinessId = ReadinessIdSchema.safeParse(readinessIdInput)
    if (!readinessId.success || readinessId.data !== access.value.room.readinessId) {
      return rejected('stale-readiness', 'The waiting-room roster has changed.', {
        roomId: access.value.room.roomId,
        currentRoomRevision: access.value.room.roomRevision,
        currentReadinessId: access.value.room.readinessId,
      })
    }
    if (typeof ready !== 'boolean') return rejected('validation-error', 'The ready value is invalid.')
    if (human.controller.ready === ready) return accepted(immutableRoom(access.value.room))

    if (ready && this.#wouldStart(access.value.room, human.seat)) {
      const previous = access.value.room.stage.kind === 'between-hands'
        ? access.value.room.stage.engineState
        : null
      const initialized = previous ? this.#initializeNextHand(previous) : this.#initializeHand()
      if (!initialized.accepted) return rejected('internal-error', 'The hand could not be initialized.')
      const handId = this.#newId(HandIdSchema, 'hand')
      if (!handId.ok) return handId
      if (initialized.state.phase.kind === 'ended') {
        const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
        if (!readinessId.ok) return readinessId
        human.controller.ready = true
        access.value.room.stage = {
          kind: 'between-hands',
          handId: handId.value,
          gameRevision: 0,
          engineState: initialized.state,
        }
        access.value.room.choices = new Map()
        this.#resetReadiness(access.value.room, readinessId.value)
        return accepted(immutableRoom(access.value.room))
      }
      const window = this.#createPhaseWindow(initialized.state)
      if (!window.ok) return window
      human.controller.ready = true
      access.value.room.stage = {
        kind: 'playing',
        handId: handId.value,
        phaseId: window.value.phaseId,
        gameRevision: 0,
        engineState: initialized.state,
      }
      access.value.room.choices = window.value.choices
      access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
      return accepted(immutableRoom(access.value.room))
    }

    human.controller.ready = ready
    access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
    return accepted(immutableRoom(access.value.room))
  }

  leaveRoom(control: SessionControl, roomIdInput: unknown): RoomServiceResult<RoomState> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const pendingRoom = this.#rooms.get(roomId.data)
    if (
      pendingRoom
      && authorization.value.roomId === pendingRoom.roomId
      && pendingRoom.spectators.has(authorization.value.sessionId)
    ) {
      pendingRoom.spectators.delete(authorization.value.sessionId)
      pendingRoom.takeoverReservations = pendingRoom.takeoverReservations.filter(
        (reservation) => reservation.sessionId !== authorization.value.sessionId,
      )
      authorization.value.roomId = null
      pendingRoom.roomRevision = nextRevision(pendingRoom.roomRevision)
      return accepted(immutableRoom(pendingRoom), [authorization.value.sessionId])
    }
    const reservationIndex = pendingRoom?.takeoverReservations.findIndex(
      (reservation) => reservation.sessionId === authorization.value.sessionId,
    ) ?? -1
    if (pendingRoom && authorization.value.roomId === pendingRoom.roomId && reservationIndex >= 0) {
      pendingRoom.takeoverReservations.splice(reservationIndex, 1)
      authorization.value.roomId = null
      pendingRoom.roomRevision = nextRevision(pendingRoom.roomRevision)
      return accepted(immutableRoom(pendingRoom), [authorization.value.sessionId])
    }
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human) return rejected('not-seated', 'The session is not seated in this room.')
    if (!this.#isPreHand(access.value.room)) {
      if (human.controller.connected) {
        if (access.value.room.stage.kind === 'playing') {
          const window = this.#createPhaseWindow(access.value.room.stage.engineState)
          if (!window.ok) return window
          access.value.room.stage = { ...access.value.room.stage, phaseId: window.value.phaseId }
          access.value.room.choices = window.value.choices
        }
        access.value.room.proposal = null
        human.controller.connected = false
        access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
      }
      return accepted(immutableRoom(access.value.room))
    }

    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    access.value.room.proposal = null
    access.value.room.seats[human.seat].controller = { kind: 'available' }
    access.value.session.roomId = null
    this.#resetReadiness(access.value.room, readinessId.value)
    return accepted(immutableRoom(access.value.room), [access.value.session.sessionId])
  }

  createProposal(control: SessionControl, input: ProposalCreateInput): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, input.roomId)
    if (!access.ok) return access
    const room = access.value.room
    const proposer = this.#humanSeatForSession(room, access.value.session.sessionId)
    if (!proposer || !proposer.controller.connected) {
      return rejected('vote-not-eligible', 'Only a connected seated human can create a proposal.')
    }
    if (room.proposal) {
      return rejected('proposal-active', 'Another proposal is already active.', {
        roomId: room.roomId,
        currentRoomRevision: room.roomRevision,
        currentProposalId: room.proposal.proposalId,
      })
    }
    if (!room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected)) {
      return rejected('invalid-room-state', 'A proposal requires a disconnected human seat.')
    }

    let targetSeat: Seat | null = null
    if (input.proposal.kind === 'abort-hand') {
      if (room.stage.kind !== 'playing') {
        return rejected('invalid-room-state', 'Only an active hand can be aborted.')
      }
    } else if (input.proposal.kind === 'replace-with-bot') {
      if (!Number.isInteger(input.proposal.targetSeat) || ![0, 1, 2, 3].includes(input.proposal.targetSeat)) {
        return rejected('validation-error', 'The target seat is invalid.')
      }
      targetSeat = input.proposal.targetSeat
      const target = room.seats[targetSeat]
      if (target.controller.kind !== 'human' || target.controller.connected) {
        return rejected('seat-unavailable', 'Only a disconnected human seat can be replaced.')
      }
    } else {
      return rejected('validation-error', 'The proposal is invalid.')
    }

    const proposalId = this.#newProposalId()
    if (!proposalId.ok) return proposalId
    const eligibleSeats = new Set(room.seats.flatMap((seat) => (
      seat.controller.kind === 'human' && seat.controller.connected ? [seat.seat] : []
    )))
    room.proposal = {
      proposalId: proposalId.value,
      kind: input.proposal.kind,
      proposedBy: proposer.seat,
      targetSeat,
      eligibleSeats,
      approvals: new Set([proposer.seat]),
    }
    if (eligibleSeats.size === 1) {
      const committed = this.#commitProposal(room)
      if (!committed.ok) room.proposal = null
      return committed
    }
    room.roomRevision = nextRevision(room.roomRevision)
    return accepted(immutableRoom(room))
  }

  voteOnProposal(control: SessionControl, input: ProposalVoteInput): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, input.roomId)
    if (!access.ok) return access
    const room = access.value.room
    const proposalId = ProposalIdSchema.safeParse(input.proposalId)
    if (!proposalId.success) return rejected('validation-error', 'The proposal identifier is invalid.')
    const proposal = room.proposal
    if (!proposal || proposal.proposalId !== proposalId.data) {
      return rejected('proposal-not-found', 'The proposal is no longer active.', {
        roomId: room.roomId,
        currentRoomRevision: room.roomRevision,
        ...(proposal ? { currentProposalId: proposal.proposalId } : {}),
      })
    }
    const voter = this.#humanSeatForSession(room, access.value.session.sessionId)
    if (!voter || !voter.controller.connected || !proposal.eligibleSeats.has(voter.seat)) {
      return rejected('vote-not-eligible', 'The session is not eligible to vote on this proposal.')
    }
    if (input.vote === 'reject') {
      room.proposal = null
      room.roomRevision = nextRevision(room.roomRevision)
      return accepted(immutableRoom(room))
    }
    if (input.vote !== 'approve') return rejected('validation-error', 'The proposal vote is invalid.')
    if (proposal.approvals.has(voter.seat)) return accepted(immutableRoom(room))
    proposal.approvals.add(voter.seat)
    if (proposal.approvals.size === proposal.eligibleSeats.size) {
      const committed = this.#commitProposal(room)
      if (!committed.ok) proposal.approvals.delete(voter.seat)
      return committed
    }
    room.roomRevision = nextRevision(room.roomRevision)
    return accepted(immutableRoom(room))
  }

  commitApprovedBotReplacement(roomIdInput: unknown, seatInput: unknown): RoomServiceResult<RoomState> {
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    if (!Number.isInteger(seatInput) || ![0, 1, 2, 3].includes(seatInput as number)) {
      return rejected('validation-error', 'The seat is invalid.')
    }
    const seat = room.seats[seatInput as Seat]
    if (seat.controller.kind !== 'human' || seat.controller.connected) {
      return rejected('seat-unavailable', 'Only a disconnected human seat can be replaced.')
    }
    return this.#replaceDisconnectedHumanWithBot(room, seat)
  }

  getRoomLifecycleTarget(roomIdInput: unknown): RoomServiceResult<RoomLifecycleTarget> {
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    return accepted(Object.freeze({
      roomId: room.roomId,
      identity: room.lifecycleIdentity,
      hasConnectedHuman: room.seats.some(
        (seat) => seat.controller.kind === 'human' && seat.controller.connected,
      ),
    }))
  }

  getSessionLifecycleTarget(sessionIdInput: unknown): RoomServiceResult<SessionLifecycleTarget> {
    const sessionId = SessionIdSchema.safeParse(sessionIdInput)
    if (!sessionId.success) return rejected('invalid-session', 'The session was not found.')
    const session = this.#sessions.get(sessionId.data)
    if (!session) return rejected('invalid-session', 'The session was not found.')
    return accepted(Object.freeze({
      sessionId: session.sessionId,
      identity: session.lifecycleIdentity,
      isInactiveAndUnattached: session.roomId === null && session.controllerId === null,
    }))
  }

  expireAbandonedRoom(roomIdInput: unknown, identity: object): RoomServiceResult<RoomExpiration> {
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room || room.lifecycleIdentity !== identity) return rejected('room-not-found', 'The room was not found.')
    if (room.seats.some((seat) => seat.controller.kind === 'human' && seat.controller.connected)) {
      return rejected('invalid-room-state', 'The room is no longer abandoned.')
    }
    return this.#deleteRoom(room)
  }

  expireRoom(roomIdInput: unknown): RoomServiceResult<RoomExpiration> {
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    return this.#deleteRoom(room)
  }

  #deleteRoom(room: RoomRecord): RoomServiceResult<RoomExpiration> {
    const detachedSessionIds = new Set<SessionId>()
    for (const seat of room.seats) {
      if (seat.controller.kind !== 'human') continue
      const session = this.#sessions.get(seat.controller.sessionId)
      if (session?.roomId === room.roomId) {
        session.roomId = null
        session.roomError = { code: 'room-expired', message: 'The room has expired.' }
        detachedSessionIds.add(session.sessionId)
      }
    }
    for (const reservation of room.takeoverReservations) {
      const session = this.#sessions.get(reservation.sessionId)
      if (session?.roomId === room.roomId) {
        session.roomId = null
        session.roomError = { code: 'room-expired', message: 'The room has expired.' }
        detachedSessionIds.add(session.sessionId)
      }
    }
    for (const sessionId of room.spectators.keys()) {
      const session = this.#sessions.get(sessionId)
      if (session?.roomId === room.roomId) {
        session.roomId = null
        session.roomError = { code: 'room-expired', message: 'The room has expired.' }
        detachedSessionIds.add(session.sessionId)
      }
    }
    room.choices.clear()
    room.proposal = null
    room.takeoverReservations = []
    this.#rooms.delete(room.roomId)
    this.#roomsByCode.delete(room.roomCode)
    this.#recordExpiredCode(room.roomCode)
    const expiration = Object.freeze({
      expired: true,
      roomId: room.roomId,
      roomCode: room.roomCode,
      detachedSessionIds: Object.freeze([...detachedSessionIds]),
    })
    return accepted(expiration, detachedSessionIds)
  }

  expireInactiveSession(sessionIdInput: unknown, identity: object): RoomServiceResult<{ readonly expired: true }> {
    const target = this.getSessionLifecycleTarget(sessionIdInput)
    if (!target.ok) return target
    if (target.value.identity !== identity) return rejected('invalid-session', 'The session was not found.')
    return this.expireSession(sessionIdInput)
  }

  expireSession(sessionIdInput: unknown): RoomServiceResult<{ readonly expired: true }> {
    const sessionId = SessionIdSchema.safeParse(sessionIdInput)
    if (!sessionId.success) return rejected('invalid-session', 'The session was not found.')
    const session = this.#sessions.get(sessionId.data)
    if (!session) return rejected('invalid-session', 'The session was not found.')
    if (session.roomId !== null || session.controllerId !== null) {
      return rejected('invalid-session', 'Only an inactive, unseated session can expire.')
    }
    this.#sessions.delete(session.sessionId)
    this.#sessionsByCredentialDigest.delete(session.credentialDigest)
    return accepted(Object.freeze({ expired: true }))
  }

  #commitProposal(room: RoomRecord): RoomServiceResult<RoomState> {
    const proposal = room.proposal
    if (!proposal || proposal.approvals.size !== proposal.eligibleSeats.size) {
      return rejected('proposal-not-found', 'The proposal is not ready to commit.')
    }
    if (proposal.kind === 'replace-with-bot') {
      const targetSeat = proposal.targetSeat
      if (targetSeat === null) return rejected('internal-error', 'The replacement proposal has no target seat.')
      const target = room.seats[targetSeat]
      if (target.controller.kind !== 'human' || target.controller.connected) {
        return rejected('seat-unavailable', 'The replacement target is no longer disconnected.')
      }
      return this.#replaceDisconnectedHumanWithBot(room, target)
    }
    if (room.stage.kind !== 'playing') {
      return rejected('invalid-room-state', 'The hand is no longer active.')
    }
    const aborted = abortHand(room.stage.engineState)
    if (!aborted.accepted || aborted.state.phase.kind !== 'ended') {
      return rejected('internal-error', 'The active hand could not be aborted.')
    }
    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    room.stage = {
      kind: 'between-hands',
      handId: room.stage.handId,
      gameRevision: nextRevision(room.stage.gameRevision),
      engineState: aborted.state,
    }
    room.choices = new Map()
    room.proposal = null
    const detachedSessionIds = this.#commitPendingTakeovers(room)
    this.#resetReadiness(room, readinessId.value)
    return accepted(immutableRoom(room), detachedSessionIds)
  }

  #replaceDisconnectedHumanWithBot(
    room: RoomRecord,
    seat: MutableSeat,
  ): RoomServiceResult<RoomState> {
    if (seat.controller.kind !== 'human' || seat.controller.connected) {
      return rejected('seat-unavailable', 'Only a disconnected human seat can be replaced.')
    }
    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    const session = this.#sessions.get(seat.controller.sessionId)
    const detachedSessionIds = new Set<SessionId>()
    if (session?.roomId === room.roomId) {
      session.roomId = null
      detachedSessionIds.add(session.sessionId)
    }
    seat.controller = { kind: 'bot' }
    room.proposal = null
    this.#resetReadiness(room, readinessId.value)
    return accepted(immutableRoom(room), detachedSessionIds)
  }

  #commitPendingTakeovers(room: RoomRecord): readonly SessionId[] {
    if (room.takeoverReservations.length === 0) return []
    let committed = false
    const detachedSessionIds = new Set<SessionId>()
    for (const reservation of room.takeoverReservations) {
      const session = this.#sessions.get(reservation.sessionId)
      const seat = room.seats[reservation.seat]
      if (
        !session
        || session.roomId !== room.roomId
        || session.controllerId === null
        || seat.controller.kind !== 'bot'
      ) {
        if (session?.roomId === room.roomId && !room.spectators.has(reservation.sessionId)) {
          session.roomId = null
          detachedSessionIds.add(session.sessionId)
        }
        continue
      }
      seat.controller = this.#newHumanController(session)
      room.spectators.delete(session.sessionId)
      committed = true
    }
    room.takeoverReservations = []
    if (committed) room.proposal = null
    return Object.freeze([...detachedSessionIds])
  }

  #authorize(control: SessionControl): RoomServiceResult<SessionRecord> {
    const sessionId = SessionIdSchema.safeParse(control.sessionId)
    const controllerId = parseControllerId(control.controllerId)
    if (!sessionId.success || !controllerId.ok) return rejected('invalid-session', 'The session is invalid.')
    const session = this.#sessions.get(sessionId.data)
    if (!session) return rejected('invalid-session', 'The session is invalid.')
    if (session.controllerId === null) return rejected('invalid-controller', 'The session has no active controller.')
    if (session.controllerId !== controllerId.value) {
      return rejected('session-superseded', 'A newer connection controls this session.')
    }
    return accepted(session)
  }

  #accessRoom(
    control: SessionControl,
    roomIdInput: unknown,
  ): RoomServiceResult<{ readonly session: SessionRecord; readonly room: RoomRecord }> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    if (authorization.value.roomId === null) return rejected('not-seated', 'The session is not seated in a room.')
    if (authorization.value.roomId !== room.roomId) return rejected('unauthorized', 'The session is seated in another room.')
    return accepted({ session: authorization.value, room })
  }

  #expectRevision(room: RoomRecord, revisionInput: unknown): RoomServiceResult<true> {
    const revision = RevisionSchema.safeParse(revisionInput)
    if (!revision.success) return rejected('validation-error', 'The expected room revision is invalid.')
    if (revision.data !== room.roomRevision) {
      return rejected('stale-room', 'The room has changed.', {
        roomId: room.roomId,
        currentRoomRevision: room.roomRevision,
        currentReadinessId: room.readinessId,
      })
    }
    return accepted(true)
  }

  #newHumanController(session: SessionRecord): MutableHumanController {
    return {
      kind: 'human',
      sessionId: session.sessionId,
      displayName: session.displayName,
      connected: true,
      ready: false,
    }
  }

  #humanSeatForSession(room: RoomRecord, sessionId: SessionId): MutableSeat & { controller: MutableHumanController } | null {
    const seat = room.seats.find((candidate) => (
      candidate.controller.kind === 'human' && candidate.controller.sessionId === sessionId
    ))
    return seat?.controller.kind === 'human'
      ? seat as MutableSeat & { controller: MutableHumanController }
      : null
  }

  #isPreHand(room: RoomRecord): boolean {
    return room.stage.kind === 'waiting' || room.stage.kind === 'between-hands'
  }

  #wouldStart(room: RoomRecord, newlyReadySeat: Seat): boolean {
    let humanCount = 0
    for (const seat of room.seats) {
      const controller = seat.controller
      if (controller.kind === 'available') return false
      if (controller.kind === 'human') {
        humanCount += 1
        if (!controller.connected || (!controller.ready && seat.seat !== newlyReadySeat)) return false
      }
    }
    return humanCount > 0
  }

  #canStart(room: RoomRecord): boolean {
    if (!this.#isPreHand(room)) return false
    let humanCount = 0
    for (const seat of room.seats) {
      const controller = seat.controller
      if (controller.kind === 'available') return false
      if (controller.kind === 'human') {
        humanCount += 1
        if (!controller.connected || !controller.ready) return false
      }
    }
    return humanCount > 0
  }

  #startReadyRoom(room: RoomRecord): void {
    if (!this.#canStart(room)) return
    const previous = room.stage.kind === 'between-hands' ? room.stage.engineState : null
    const initialized = previous ? this.#initializeNextHand(previous) : this.#initializeHand()
    if (!initialized.accepted) return
    const handId = this.#newId(HandIdSchema, 'hand')
    if (!handId.ok) return
    if (initialized.state.phase.kind === 'ended') {
      const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
      if (!readinessId.ok) return
      room.stage = {
        kind: 'between-hands',
        handId: handId.value,
        gameRevision: 0,
        engineState: initialized.state,
      }
      room.choices = new Map()
      this.#resetReadiness(room, readinessId.value)
      return
    }
    const window = this.#createPhaseWindow(initialized.state)
    if (!window.ok) return
    room.stage = {
      kind: 'playing',
      handId: handId.value,
      phaseId: window.value.phaseId,
      gameRevision: 0,
      engineState: initialized.state,
    }
    room.choices = window.value.choices
    room.roomRevision = nextRevision(room.roomRevision)
  }

  #createPhaseWindow(state: EngineState): RoomServiceResult<{
    readonly phaseId: PhaseId
    readonly choices: Map<Seat, Map<ChoiceId, EngineAction>>
  }> {
    const phaseId = this.#newId(PhaseIdSchema, 'phase')
    if (!phaseId.ok) return phaseId
    const choices = new Map<Seat, Map<ChoiceId, EngineAction>>()
    const issuedIds = new Set<ChoiceId>()
    for (const seat of [0, 1, 2, 3] as const) {
      const seatChoices = new Map<ChoiceId, EngineAction>()
      for (const action of getLegalActions(state, seat)) {
        const parsed = ChoiceIdSchema.safeParse(this.#createChoiceId())
        if (!parsed.success || issuedIds.has(parsed.data)) {
          return rejected('internal-error', 'The choice identifier generator failed.')
        }
        issuedIds.add(parsed.data)
        seatChoices.set(parsed.data, action)
      }
      if (seatChoices.size > 0) choices.set(seat, seatChoices)
    }
    return accepted({ phaseId: phaseId.value, choices })
  }

  #resetReadiness(room: RoomRecord, readinessId: ReadinessId): void {
    for (const seat of room.seats) {
      if (seat.controller.kind === 'human') seat.controller.ready = false
    }
    room.readinessId = readinessId
    room.roomRevision = nextRevision(room.roomRevision)
  }

  #newId<T extends string>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } }, label: string): RoomServiceResult<T> {
    const parsed = schema.safeParse(this.#createId())
    return parsed.success ? accepted(parsed.data) : rejected('internal-error', `The ${label} identifier generator failed.`)
  }

  #newCredential(): RoomServiceResult<ReconnectCredential> {
    for (let attempt = 0; attempt < this.#maxCodeAttempts; attempt += 1) {
      const parsed = ReconnectCredentialSchema.safeParse(this.#createCredential())
      if (!parsed.success) continue
      if (!this.#sessionsByCredentialDigest.has(credentialDigest(parsed.data))) return accepted(parsed.data)
    }
    return rejected('internal-error', 'A unique reconnect credential could not be generated.')
  }

  #newProposalId(): RoomServiceResult<ProposalId> {
    const parsed = ProposalIdSchema.safeParse(this.#createProposalId())
    return parsed.success
      ? accepted(parsed.data)
      : rejected('internal-error', 'The proposal identifier generator failed.')
  }

  #newTakeoverId(): RoomServiceResult<TakeoverId> {
    const parsed = TakeoverIdSchema.safeParse(this.#createTakeoverId())
    return parsed.success
      ? accepted(parsed.data)
      : rejected('internal-error', 'The takeover identifier generator failed.')
  }

  #newRoomCode(): RoomServiceResult<RoomCode> {
    for (let attempt = 0; attempt < this.#maxCodeAttempts; attempt += 1) {
      const parsed = RoomCodeSchema.safeParse(this.#createRoomCode())
      if (!parsed.success) continue
      if (!this.#roomsByCode.has(parsed.data)) return accepted(parsed.data)
    }
    return rejected('internal-error', 'A unique room code could not be generated.')
  }

  #recordExpiredCode(roomCode: RoomCode): void {
    this.#expiredCodes.delete(roomCode)
    this.#expiredCodes.add(roomCode)
    while (this.#expiredCodes.size > this.#maxExpiredCodes) {
      const oldest = this.#expiredCodes.values().next().value
      if (oldest === undefined) break
      this.#expiredCodes.delete(oldest)
    }
  }

  #lobbySummary(room: RoomRecord): LobbySummary {
    const humanCount = room.seats.filter((seat) => seat.controller.kind === 'human').length
    const availableSeatCount = room.seats.filter((seat) => seat.controller.kind === 'available').length
    const reservedSeats = new Set(room.takeoverReservations.map((reservation) => reservation.seat))
    const takeoverSeatCount = room.seats.filter(
      (seat) => seat.controller.kind === 'bot' && !reservedSeats.has(seat.seat),
    ).length
    return Object.freeze({
      roomId: room.roomId,
      roomCode: room.roomCode,
      visibility: 'public',
      status: room.stage.kind,
      isPaused: room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected),
      humanCount,
      availableSeatCount,
      takeoverSeatCount,
      spectatorCount: [...room.spectators.values()].filter((spectator) => spectator.connected).length,
    })
  }


  #roomEntrySummary(room: RoomRecord): RoomEntrySummary {
    const reservedSeats = new Set(room.takeoverReservations.map((reservation) => reservation.seat))
    return Object.freeze({
      roomCode: room.roomCode,
      status: room.stage.kind,
      isPaused: room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected),
      humanCount: room.seats.filter((seat) => seat.controller.kind === 'human').length,
      spectatorCount: [...room.spectators.values()].filter((spectator) => spectator.connected).length,
      availableSeatCount: room.seats.filter((seat) => seat.controller.kind === 'available').length,
      takeoverSeats: room.seats
        .filter((seat) => seat.controller.kind === 'bot' && !reservedSeats.has(seat.seat))
        .map((seat) => seat.seat),
      seats: room.seats.map(({ seat, controller }) => {
        if (controller.kind === 'available') return { seat, kind: 'available' as const }
        if (controller.kind === 'bot') {
          return { seat, kind: 'bot' as const, takeoverAvailable: !reservedSeats.has(seat) }
        }
        return {
          seat,
          kind: 'human' as const,
          displayName: controller.displayName,
          connection: controller.connected ? 'connected' as const : 'disconnected' as const,
        }
      }),
    })
  }
}
