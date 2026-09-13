import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'

import {
  DisplayNameSchema,
  HandIdSchema,
  ReadinessIdSchema,
  ReconnectCredentialSchema,
  RevisionSchema,
  RoomCodeSchema,
  RoomIdSchema,
  SessionIdSchema,
  VisibilitySchema,
  type CommandError,
  type DisplayName,
  type LobbySummary,
  type ReadinessId,
  type ReconnectCredential,
  type Revision,
  type RoomCode,
  type RoomId,
  type Seat,
  type SessionId,
  type Visibility,
} from '@cg-filipino-mahjong/shared'

import {
  initializeHand,
  type EngineTransitionResult,
} from '../game-engine/index.js'
import type {
  FourRoomSeats,
  GuestSession,
  PublicLobby,
  RoomSeat,
  RoomSeatController,
  RoomServiceResult,
  RoomStage,
  RoomState,
  SessionAuthentication,
  SessionBootstrap,
  SessionControl,
  SessionDisconnection,
} from './model.js'

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

interface RoomRecord {
  readonly roomId: RoomId
  readonly roomCode: RoomCode
  visibility: Visibility
  roomRevision: Revision
  readinessId: ReadinessId
  readonly seats: [MutableSeat, MutableSeat, MutableSeat, MutableSeat]
  stage: RoomStage
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
}

function accepted<T>(value: T): RoomServiceResult<T> {
  return { ok: true, value }
}

function rejected<T>(code: CommandError['code'], message: string): RoomServiceResult<T> {
  return { ok: false, error: { code, message } }
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

function immutableRoom(room: RoomRecord): RoomState {
  return Object.freeze({
    roomId: room.roomId,
    roomCode: room.roomCode,
    visibility: room.visibility,
    roomRevision: room.roomRevision,
    readinessId: room.readinessId,
    seats: immutableSeats(room.seats),
    stage: immutableStage(room.stage),
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

export class RoomService {
  readonly #maxRooms: number
  readonly #maxSessions: number
  readonly #maxCodeAttempts: number
  readonly #maxExpiredCodes: number
  readonly #createId: () => string
  readonly #createCredential: () => string
  readonly #createRoomCode: () => string
  readonly #initializeHand: () => EngineTransitionResult
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

    const supersededControllerId = session.controllerId !== null && session.controllerId !== controllerId.value
      ? session.controllerId
      : null
    if (supersededControllerId !== null) this.#sessionsByController.delete(supersededControllerId)
    session.controllerId = controllerId.value
    this.#sessionsByController.set(controllerId.value, session)
    const room = session.roomId === null ? null : this.#rooms.get(session.roomId) ?? null
    if (room) {
      const human = this.#humanSeatForSession(room, session.sessionId)
      if (human && !human.controller.connected) {
        human.controller.connected = true
        room.roomRevision = nextRevision(room.roomRevision)
        this.#startReadyRoom(room)
      }
    } else if (session.roomId !== null) {
      session.roomId = null
    }

    return accepted(Object.freeze({
      session: immutableSession(session),
      control: Object.freeze({ sessionId: session.sessionId, controllerId: controllerId.value }),
      supersededControllerId,
      room: room ? immutableRoom(room) : null,
    }))
  }

  disconnect(control: SessionControl): RoomServiceResult<SessionDisconnection> {
    const session = this.#sessions.get(control.sessionId)
    if (!session || session.controllerId !== control.controllerId) {
      return accepted(Object.freeze({ disconnected: false, room: null }))
    }
    this.#sessionsByController.delete(control.controllerId)
    session.controllerId = null
    const room = session.roomId === null ? null : this.#rooms.get(session.roomId) ?? null
    if (room) {
      const human = this.#humanSeatForSession(room, session.sessionId)
      if (human && human.controller.connected) {
        human.controller.connected = false
        room.roomRevision = nextRevision(room.roomRevision)
      }
    }
    return accepted(Object.freeze({ disconnected: true, room: room ? immutableRoom(room) : null }))
  }

  listPublicRooms(control: SessionControl): RoomServiceResult<PublicLobby> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    const rooms = [...this.#rooms.values()]
      .filter((room) => room.visibility === 'public')
      .map((room) => this.#lobbySummary(room))
    return accepted(Object.freeze({ rooms: Object.freeze(rooms) }))
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
    }
    authorization.value.roomId = room.roomId
    this.#rooms.set(room.roomId, room)
    this.#roomsByCode.set(room.roomCode, room)
    this.#expiredCodes.delete(room.roomCode)
    return accepted(immutableRoom(room))
  }

  joinRoom(control: SessionControl, roomCodeInput: unknown): RoomServiceResult<RoomState> {
    const authorization = this.#authorize(control)
    if (!authorization.ok) return authorization
    if (authorization.value.roomId !== null) return rejected('already-seated', 'The session is already seated in a room.')
    const roomCode = RoomCodeSchema.safeParse(roomCodeInput)
    if (!roomCode.success) return rejected('room-not-found', 'The room code is invalid or unknown.')
    const room = this.#roomsByCode.get(roomCode.data)
    if (!room) {
      return this.#expiredCodes.has(roomCode.data)
        ? rejected('room-expired', 'The room has expired.')
        : rejected('room-not-found', 'The room was not found.')
    }
    if (room.stage.kind !== 'waiting' && room.stage.kind !== 'between-hands') {
      return rejected('invalid-room-state', 'The room is already playing.')
    }
    const seat = room.seats.find((candidate) => candidate.controller.kind === 'available')
    if (!seat) return rejected('room-full', 'The room has no available human seat.')

    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    seat.controller = this.#newHumanController(authorization.value)
    authorization.value.roomId = room.roomId
    this.#resetReadiness(room, readinessId.value)
    return accepted(immutableRoom(room))
  }

  setVisibility(
    control: SessionControl,
    roomIdInput: unknown,
    expectedRevisionInput: unknown,
    visibilityInput: unknown,
  ): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
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
    if (!this.#isPreHand(access.value.room)) return rejected('invalid-room-state', 'Readiness can change only between hands.')
    const readinessId = ReadinessIdSchema.safeParse(readinessIdInput)
    if (!readinessId.success || readinessId.data !== access.value.room.readinessId) {
      return rejected('stale-readiness', 'The waiting-room roster has changed.')
    }
    if (typeof ready !== 'boolean') return rejected('validation-error', 'The ready value is invalid.')
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human || !human.controller.connected) return rejected('invalid-controller', 'The session does not control a connected room seat.')
    if (human.controller.ready === ready) return accepted(immutableRoom(access.value.room))

    if (ready && this.#wouldStart(access.value.room, human.seat)) {
      const initialized = this.#initializeHand()
      if (!initialized.accepted) return rejected('internal-error', 'The hand could not be initialized.')
      const handId = this.#newId(HandIdSchema, 'hand')
      if (!handId.ok) return handId
      human.controller.ready = true
      access.value.room.stage = {
        kind: 'playing',
        handId: handId.value,
        engineState: initialized.state,
      }
      access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
      return accepted(immutableRoom(access.value.room))
    }

    human.controller.ready = ready
    access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
    return accepted(immutableRoom(access.value.room))
  }

  leaveRoom(control: SessionControl, roomIdInput: unknown): RoomServiceResult<RoomState> {
    const access = this.#accessRoom(control, roomIdInput)
    if (!access.ok) return access
    const human = this.#humanSeatForSession(access.value.room, access.value.session.sessionId)
    if (!human) return rejected('not-seated', 'The session is not seated in this room.')
    if (!this.#isPreHand(access.value.room)) {
      if (human.controller.connected) {
        human.controller.connected = false
        access.value.room.roomRevision = nextRevision(access.value.room.roomRevision)
      }
      return accepted(immutableRoom(access.value.room))
    }

    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    access.value.room.seats[human.seat].controller = { kind: 'available' }
    access.value.session.roomId = null
    this.#resetReadiness(access.value.room, readinessId.value)
    return accepted(immutableRoom(access.value.room))
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
    const readinessId = this.#newId(ReadinessIdSchema, 'readiness')
    if (!readinessId.ok) return readinessId
    const session = this.#sessions.get(seat.controller.sessionId)
    if (session?.roomId === room.roomId) session.roomId = null
    seat.controller = { kind: 'bot' }
    this.#resetReadiness(room, readinessId.value)
    return accepted(immutableRoom(room))
  }

  expireRoom(roomIdInput: unknown): RoomServiceResult<{ readonly expired: true }> {
    const roomId = RoomIdSchema.safeParse(roomIdInput)
    if (!roomId.success) return rejected('room-not-found', 'The room was not found.')
    const room = this.#rooms.get(roomId.data)
    if (!room) return rejected('room-not-found', 'The room was not found.')
    for (const seat of room.seats) {
      if (seat.controller.kind !== 'human') continue
      const session = this.#sessions.get(seat.controller.sessionId)
      if (session?.roomId === room.roomId) session.roomId = null
    }
    this.#rooms.delete(room.roomId)
    this.#roomsByCode.delete(room.roomCode)
    this.#recordExpiredCode(room.roomCode)
    return accepted(Object.freeze({ expired: true }))
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
    if (revision.data !== room.roomRevision) return rejected('stale-room', 'The room has changed.')
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
    const initialized = this.#initializeHand()
    if (!initialized.accepted) return
    const handId = this.#newId(HandIdSchema, 'hand')
    if (!handId.ok) return
    room.stage = { kind: 'playing', handId: handId.value, engineState: initialized.state }
    room.roomRevision = nextRevision(room.roomRevision)
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
    const takeoverSeatCount = room.seats.filter((seat) => seat.controller.kind === 'bot').length
    return Object.freeze({
      roomId: room.roomId,
      roomCode: room.roomCode,
      visibility: 'public',
      status: room.stage.kind,
      isPaused: room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected),
      humanCount,
      availableSeatCount,
      takeoverSeatCount,
    })
  }
}
