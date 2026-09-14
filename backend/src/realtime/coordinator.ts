import {
  ClientCommandSchema,
  CommandIdSchema,
  type ClientCommand,
  type CommandAcknowledgement,
  type CommandError,
  type CommandId,
  type CommandResult,
  type HandId,
  type LegalChoice,
  type PhaseId,
  type RoomSnapshot,
  type RoomId,
  type Seat,
} from '@cg-filipino-mahjong/shared'

import { chooseBotChoice } from '../bots/index.js'
import { systemRandomSource, type RandomSource } from '../game-engine/index.js'
import {
  RoomService,
  type RoomExpiration,
  type RoomServiceResult,
  type RoomState,
  type SessionAuthentication,
  type SessionControl,
} from '../room-service/index.js'

export interface RealtimeViewPort {
  snapshotFor(control: SessionControl, room: RoomState): Promise<RoomSnapshot | undefined> | RoomSnapshot | undefined
  roomChanged(room: RoomState): Promise<void> | void
  lobbyChanged(): Promise<void> | void
  roomExpired?(expiration: RoomExpiration): Promise<void> | void
}

export interface RealtimeCoordinatorOptions {
  readonly roomService?: RoomService
  readonly viewPort?: RealtimeViewPort
  readonly commandHistoryLimit?: number
  readonly botDecisionDelayMs?: number
  readonly botRandomSource?: RandomSource
  readonly botTimers?: BotTimerPort
  readonly lifecycleScheduler?: LifecycleScheduler
  readonly expirationMs?: number
}

export interface BotTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LifecycleScheduler extends BotTimerPort {
  now(): number
}

export interface CommandHandlingResult {
  readonly acknowledgement: CommandAcknowledgement
  readonly control?: SessionControl
  readonly room?: RoomState
  readonly leftRoomId?: string
}

interface HistoryEntry {
  readonly fingerprint: string
  readonly acknowledgement: CommandAcknowledgement
  readonly roomId: RoomId | null
}

interface ScheduledBotDecision {
  readonly roomId: RoomId
  readonly roomIdentity: object
  readonly seat: Seat
  readonly handId: HandId
  readonly phaseId: PhaseId
  readonly choice: LegalChoice
  readonly handle: unknown
}

interface ScheduledLifecycleExpiration {
  readonly identity: object
  readonly deadline: number
  readonly handle: unknown
}

const noViews: RealtimeViewPort = {
  snapshotFor: () => undefined,
  roomChanged: () => undefined,
  lobbyChanged: () => undefined,
  roomExpired: () => undefined,
}

const systemBotTimers: BotTimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const systemLifecycleScheduler: LifecycleScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs)
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const DEFAULT_EXPIRATION_MS = 15 * 60 * 1_000

function validLimit(value: number | undefined): number {
  const resolved = value ?? 256
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('commandHistoryLimit must be a positive safe integer.')
  }
  return resolved
}

function validBotDelay(value: number | undefined): number {
  const resolved = value ?? 600
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error('botDecisionDelayMs must be a non-negative safe integer.')
  }
  return resolved
}

function validExpiration(value: number | undefined): number {
  const resolved = value ?? DEFAULT_EXPIRATION_MS
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('expirationMs must be a positive safe integer.')
  }
  return resolved
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}

function rejected(
  commandId: CommandId | null,
  error: CommandError,
  snapshot?: RoomSnapshot,
): CommandAcknowledgement {
  return snapshot
    ? { commandId, status: 'rejected', duplicate: false, error, snapshot }
    : { commandId, status: 'rejected', duplicate: false, error }
}

function accepted(commandId: CommandId, result: CommandResult): CommandAcknowledgement {
  return { commandId, status: 'accepted', duplicate: false, result }
}

function asDuplicate(acknowledgement: CommandAcknowledgement): CommandAcknowledgement {
  return { ...acknowledgement, duplicate: true }
}

export class RealtimeCoordinator {
  readonly roomService: RoomService
  readonly #viewPort: RealtimeViewPort
  readonly #commandHistoryLimit: number
  readonly #botDecisionDelayMs: number
  readonly #botRandomSource: RandomSource
  readonly #botTimers: BotTimerPort
  readonly #lifecycleScheduler: LifecycleScheduler
  readonly #expirationMs: number
  readonly #history = new Map<string, Map<CommandId, HistoryEntry>>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #scheduledBots = new Map<string, ScheduledBotDecision>()
  readonly #scheduledRoomExpirations = new Map<RoomId, ScheduledLifecycleExpiration>()
  readonly #scheduledSessionExpirations = new Map<string, ScheduledLifecycleExpiration>()
  #disposed = false

  constructor(options: RealtimeCoordinatorOptions = {}) {
    this.roomService = options.roomService ?? new RoomService()
    this.#viewPort = options.viewPort ?? noViews
    this.#commandHistoryLimit = validLimit(options.commandHistoryLimit)
    this.#botDecisionDelayMs = validBotDelay(options.botDecisionDelayMs)
    this.#botRandomSource = options.botRandomSource ?? systemRandomSource
    this.#botTimers = options.botTimers ?? systemBotTimers
    this.#lifecycleScheduler = options.lifecycleScheduler ?? systemLifecycleScheduler
    this.#expirationMs = validExpiration(options.expirationMs)
  }

  authenticate(credential: string, controllerId: string): Promise<RoomServiceResult<SessionAuthentication>> {
    const target = this.roomService.resolveReconnectTarget(credential)
    if (!target.ok) return Promise.resolve(target)
    return this.#enqueue(`session:${target.value.sessionId}`, async () => {
      const authenticate = async () => {
        const result = this.roomService.authenticate(credential, controllerId)
        if (result.ok) {
          this.#reconcileSessionExpirations([
            result.value.control.sessionId,
            ...result.detachedSessionIds,
          ])
          if (result.value.room) await this.#notifyRoomChanged(result.value.room)
        }
        return result
      }
      return target.value.roomId
        ? this.runRoomOperation(target.value.roomId, authenticate)
        : authenticate()
    })
  }

  async snapshotFor(control: SessionControl, room: RoomState): Promise<RoomSnapshot | undefined> {
    try {
      return await this.#viewPort.snapshotFor(control, room)
    } catch {
      return undefined
    }
  }

  runRoomOperation<T>(roomId: RoomId, operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(`room:${roomId}`, operation)
  }

  cancelBotDecisions(roomId: RoomId): void {
    for (const [key, scheduled] of this.#scheduledBots) {
      if (scheduled.roomId !== roomId) continue
      this.#botTimers.clearTimeout(scheduled.handle)
      this.#scheduledBots.delete(key)
    }
  }

  expireRoom(roomId: RoomId) {
    return this.runRoomOperation(roomId, async () => {
      const result = this.roomService.expireRoom(roomId)
      if (result.ok) await this.#afterRoomExpired(result.value)
      return result
    })
  }

  expireSession(sessionId: string) {
    return this.#enqueue(`session:${sessionId}`, async () => {
      const result = this.roomService.expireSession(sessionId)
      if (result.ok) this.#afterSessionExpired(sessionId)
      return result
    })
  }

  dispose(): void {
    this.#disposed = true
    for (const scheduled of this.#scheduledBots.values()) this.#botTimers.clearTimeout(scheduled.handle)
    this.#scheduledBots.clear()
    for (const scheduled of this.#scheduledRoomExpirations.values()) {
      this.#lifecycleScheduler.clearTimeout(scheduled.handle)
    }
    this.#scheduledRoomExpirations.clear()
    for (const scheduled of this.#scheduledSessionExpirations.values()) {
      this.#lifecycleScheduler.clearTimeout(scheduled.handle)
    }
    this.#scheduledSessionExpirations.clear()
    this.#history.clear()
  }

  async disconnect(control: SessionControl): Promise<void> {
    await this.#enqueue(`session:${control.sessionId}`, async () => {
      const controlledRoom = this.roomService.getControlledRoom(control)
      const disconnect = () => Promise.resolve(this.roomService.disconnect(control))
      const result = controlledRoom.ok && controlledRoom.value
        ? await this.runRoomOperation(controlledRoom.value.roomId, disconnect)
        : await disconnect()
      if (result.ok) {
        this.#reconcileSessionExpirations([control.sessionId, ...result.detachedSessionIds])
      }
      if (result.ok && result.value.room) {
        await this.#notifyRoomChanged(result.value.room)
      }
    })
  }

  handleCommand(
    controllerId: string,
    control: SessionControl | undefined,
    input: unknown,
  ): Promise<CommandHandlingResult> {
    const parsed = ClientCommandSchema.safeParse(input)
    const parsedId = CommandIdSchema.safeParse(
      typeof input === 'object' && input !== null && 'commandId' in input
        ? input.commandId
        : undefined,
    )
    const commandId = parsedId.success ? parsedId.data : null
    const queueKey = control ? `session:${control.sessionId}` : `controller:${controllerId}`

    return this.#enqueue(queueKey, async () => {
      if (control && commandId) {
        const replay = this.#replay(control.sessionId, commandId, fingerprint(parsed.success ? parsed.data : input))
        if (replay) return { acknowledgement: replay }
      }
      if (!parsed.success) {
        const acknowledgement = rejected(commandId, {
          code: 'validation-error',
          message: 'The command payload is invalid.',
        })
        if (control && commandId) this.#remember(control.sessionId, commandId, fingerprint(input), acknowledgement)
        return { acknowledgement }
      }
      try {
        return await this.#handleParsed(controllerId, control, parsed.data)
      } catch {
        const acknowledgement = rejected(parsed.data.commandId, {
          code: 'internal-error',
          message: 'The command could not be processed.',
        })
        if (control) {
          this.#remember(control.sessionId, parsed.data.commandId, fingerprint(parsed.data), acknowledgement)
        }
        return { acknowledgement }
      }
    })
  }

  async #handleParsed(
    controllerId: string,
    control: SessionControl | undefined,
    command: ClientCommand,
  ): Promise<CommandHandlingResult> {
    const commandFingerprint = fingerprint(command)
    if (control) {
      const replay = this.#replay(control.sessionId, command.commandId, commandFingerprint)
      if (replay) return { acknowledgement: replay }
    }

    if (command.type === 'session.bootstrap') {
      if (control) {
        return this.#finish(control, command, commandFingerprint, {
          acknowledgement: rejected(command.commandId, {
            code: 'invalid-session',
            message: 'This socket already controls a session.',
          }),
        })
      }
      const bootstrapped = this.roomService.bootstrapSession(command.displayName, controllerId)
      if (!bootstrapped.ok) {
        return { acknowledgement: rejected(command.commandId, bootstrapped.error) }
      }
      const acknowledgement = accepted(command.commandId, {
        kind: 'session-bootstrapped',
        sessionId: bootstrapped.value.session.sessionId,
        reconnectCredential: bootstrapped.value.reconnectCredential,
      })
      this.#remember(
        bootstrapped.value.session.sessionId,
        command.commandId,
        commandFingerprint,
        acknowledgement,
      )
      return {
        acknowledgement,
        control: bootstrapped.value.control,
      }
    }

    if (!control) {
      return {
        acknowledgement: rejected(command.commandId, {
          code: 'invalid-session',
          message: 'Bootstrap or reconnect a session before issuing commands.',
        }),
      }
    }

    const result = await this.#dispatch(control, command)
    return this.#finish(control, command, commandFingerprint, result)
  }

  async #dispatch(
    control: SessionControl,
    command: Exclude<ClientCommand, { type: 'session.bootstrap' }>,
  ): Promise<CommandHandlingResult> {
    if (command.type === 'lobby.list') {
      const listed = this.roomService.listPublicRooms(control)
      return listed.ok
        ? { acknowledgement: accepted(command.commandId, { kind: 'lobby-rooms', rooms: [...listed.value.rooms] }) }
        : { acknowledgement: rejected(command.commandId, listed.error) }
    }

    if (command.type === 'room.inspect') {
      const inspectedRoom = this.roomService.resolveRoomId(command.roomCode)
      const queueKey = inspectedRoom.ok
        ? `room:${inspectedRoom.value}`
        : `inspect:${command.roomCode}`
      return this.#enqueue(queueKey, async () => {
        const inspected = this.roomService.inspectRoom(control, command.roomCode)
        return inspected.ok
          ? { acknowledgement: accepted(command.commandId, { kind: 'room-entry', entry: inspected.value }) }
          : { acknowledgement: rejected(command.commandId, inspected.error) }
      })
    }

    if (command.type === 'room.takeover') {
      const takeoverRoom = this.roomService.resolveRoomId(command.roomCode)
      const queueKey = takeoverRoom.ok
        ? `room:${takeoverRoom.value}`
        : `takeover:${command.roomCode}`
      return this.#enqueue(queueKey, async () => {
        const takeover = this.roomService.requestBotSeatTakeover(control, command.roomCode, command.seat)
        if (!takeover.ok) return { acknowledgement: rejected(command.commandId, takeover.error) }
        this.#reconcileSessionExpirations(takeover.detachedSessionIds)
        await this.#notifyRoomChanged(takeover.value.room)
        if (takeover.value.kind === 'pending') {
          return {
            acknowledgement: accepted(command.commandId, {
              kind: 'takeover-pending',
              takeoverId: takeover.value.takeoverId,
            }),
            room: takeover.value.room,
          }
        }
        const snapshot = this.roomService.getRecipientSnapshot(control, takeover.value.room.roomId)
        if (!snapshot.ok) {
          return { acknowledgement: rejected(command.commandId, snapshot.error), room: takeover.value.room }
        }
        return {
          acknowledgement: accepted(command.commandId, {
            kind: 'room-snapshot',
            snapshot: snapshot.value,
          }),
          room: takeover.value.room,
        }
      })
    }

    const operation = (): RoomServiceResult<RoomState> => {
      if (command.type === 'room.create') return this.roomService.createRoom(control, command.visibility)
      if (command.type === 'room.join') return this.roomService.joinRoom(control, command.roomCode)
      if (command.type === 'room.set-visibility') {
        return this.roomService.setVisibility(
          control,
          command.roomId,
          command.expectedRoomRevision,
          command.visibility,
        )
      }
      if (command.type === 'room.configure-seat') {
        return this.roomService.configureSeat(
          control,
          command.roomId,
          command.expectedRoomRevision,
          command.seat,
          command.controller,
        )
      }
      if (command.type === 'room.set-ready') {
        return this.roomService.setReady(control, command.roomId, command.readinessId, command.ready)
      }
      if (command.type === 'proposal.create') {
        return this.roomService.createProposal(control, {
          roomId: command.roomId,
          proposal: command.proposal,
        })
      }
      if (command.type === 'proposal.vote') {
        return this.roomService.voteOnProposal(control, {
          roomId: command.roomId,
          proposalId: command.proposalId,
          vote: command.vote,
        })
      }
      if (command.type === 'room.leave') return this.roomService.leaveRoom(control, command.roomId)
      return this.roomService.applyGameAction(control, {
        roomId: command.roomId,
        handId: command.handId,
        phaseId: command.phaseId,
        action: command.action,
      })
    }

    const joinedRoom = command.type === 'room.join'
      ? this.roomService.resolveRoomId(command.roomCode)
      : null
    const roomKey = 'roomId' in command
      ? `room:${command.roomId}`
      : joinedRoom?.ok
        ? `room:${joinedRoom.value}`
        : `create:${control.sessionId}`
    return this.#enqueue(roomKey, async () => {
      const changed = operation()
      if (!changed.ok) {
        const snapshot = await this.#snapshotForError(control, changed.error)
        return { acknowledgement: rejected(command.commandId, changed.error, snapshot) }
      }
      this.#reconcileSessionExpirations(changed.detachedSessionIds)
      await this.#notifyRoomChanged(changed.value)
      return {
        acknowledgement: accepted(command.commandId, { kind: 'completed' }),
        room: changed.value,
        leftRoomId: command.type === 'room.leave' ? command.roomId : undefined,
      }
    })
  }

  async #snapshotForError(control: SessionControl, error: CommandError): Promise<RoomSnapshot | undefined> {
    const roomId = error.details?.roomId
    if (!roomId) return undefined
    const room = this.roomService.getRoom(control, roomId)
    return room.ok ? this.snapshotFor(control, room.value) : undefined
  }

  async #notifyRoomChanged(room: RoomState): Promise<void> {
    try {
      this.#reconcileRoomExpiration(room)
    } catch {
      this.#cancelRoomExpiration(room.roomId)
    }
    try {
      await this.#viewPort.roomChanged(room)
    } catch {
      // Publishing is downstream of the authoritative commit and must not change its acknowledgement.
    }
    try {
      await this.#viewPort.lobbyChanged()
    } catch {
      // BACKEND-009 can retry publication without replaying the committed command.
    }
    try {
      this.#reconcileBotDecisions(room)
    } catch {
      // Bot scheduling is downstream of the authoritative commit. A broken
      // injected random source or timer must not change the command result.
      this.cancelBotDecisions(room.roomId)
    }
  }

  #reconcileBotDecisions(room: RoomState): void {
    if (this.#disposed) return
    const prefix = `${room.roomId}:`
    const lifecycle = this.roomService.getRoomLifecycleTarget(room.roomId)
    if (!lifecycle.ok) {
      this.cancelBotDecisions(room.roomId)
      return
    }
    const roomIdentity = lifecycle.value.identity
    const eligible = room.stage.kind === 'playing'
      && room.seats.some((seat) => seat.controller.kind === 'human' && seat.controller.connected)
      && !room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected)
    const desiredKeys = new Set<string>()

    if (eligible && room.stage.kind === 'playing') {
      for (const roomSeat of room.seats) {
        if (roomSeat.controller.kind !== 'bot') continue
        const key = `${prefix}${roomSeat.seat}`
        const existing = this.#scheduledBots.get(key)
        const snapshot = this.roomService.getBotDecisionSnapshot(room.roomId, roomSeat.seat)
        const choices = snapshot.ok && snapshot.value.stage === 'playing'
          ? snapshot.value.privateState?.legalChoices ?? []
          : []
        if (choices.length === 0) continue
        desiredKeys.add(key)
        if (
          existing
          && existing.roomIdentity === roomIdentity
          && existing.handId === room.stage.handId
          && existing.phaseId === room.stage.phaseId
        ) continue

        if (existing) {
          this.#botTimers.clearTimeout(existing.handle)
          this.#scheduledBots.delete(key)
        }
        if (!snapshot.ok || snapshot.value.stage !== 'playing') continue
        const choice = chooseBotChoice(snapshot.value, this.#botRandomSource)
        if (!choice) continue
        const scheduledWithoutHandle = {
          roomId: room.roomId,
          roomIdentity,
          seat: roomSeat.seat,
          handId: room.stage.handId,
          phaseId: room.stage.phaseId,
          choice,
        }
        let scheduled!: ScheduledBotDecision
        const handle = this.#botTimers.setTimeout(() => {
          if (this.#scheduledBots.get(key) !== scheduled) return
          this.#scheduledBots.delete(key)
          void this.runRoomOperation(room.roomId, async () => {
            const currentRoom = this.roomService.getRoomLifecycleTarget(room.roomId)
            if (!currentRoom.ok || currentRoom.value.identity !== scheduled.roomIdentity) return
            const result = this.roomService.applyBotGameAction({
              roomId: room.roomId,
              seat: roomSeat.seat,
              handId: scheduled.handId,
              phaseId: scheduled.phaseId,
              choiceId: scheduled.choice.choiceId,
            })
            if (result.ok) {
              this.#reconcileSessionExpirations(result.detachedSessionIds)
              await this.#notifyRoomChanged(result.value)
            }
          }).catch(() => undefined)
        }, this.#botDecisionDelayMs)
        scheduled = { ...scheduledWithoutHandle, handle }
        this.#scheduledBots.set(key, scheduled)
      }
    }

    for (const [key, scheduled] of this.#scheduledBots) {
      if (!key.startsWith(prefix) || desiredKeys.has(key)) continue
      this.#botTimers.clearTimeout(scheduled.handle)
      this.#scheduledBots.delete(key)
    }
  }

  #finish(
    control: SessionControl,
    command: ClientCommand,
    commandFingerprint: string,
    result: CommandHandlingResult,
  ): CommandHandlingResult {
    const roomId = result.room?.roomId ?? ('roomId' in command ? command.roomId : null)
    this.#remember(control.sessionId, command.commandId, commandFingerprint, result.acknowledgement, roomId)
    this.#reconcileSessionExpirations([control.sessionId])
    return result
  }

  #replay(sessionId: string, commandId: CommandId, commandFingerprint: string): CommandAcknowledgement | undefined {
    const previous = this.#history.get(sessionId)?.get(commandId)
    if (!previous) return undefined
    if (previous.fingerprint !== commandFingerprint) {
      return {
        commandId,
        status: 'rejected',
        duplicate: true,
        error: {
          code: 'command-conflict',
          message: 'The command ID was already used for a different command.',
        },
      }
    }
    return asDuplicate(previous.acknowledgement)
  }

  #remember(
    sessionId: string,
    commandId: CommandId,
    commandFingerprint: string,
    acknowledgement: CommandAcknowledgement,
    roomId: RoomId | null = null,
  ): void {
    let history = this.#history.get(sessionId)
    if (!history) {
      history = new Map()
      this.#history.set(sessionId, history)
    }
    history.set(commandId, { fingerprint: commandFingerprint, acknowledgement, roomId })
    while (history.size > this.#commandHistoryLimit) {
      const oldest = history.keys().next().value
      if (oldest === undefined) break
      history.delete(oldest)
    }
  }

  #reconcileRoomExpiration(room: RoomState): void {
    const target = this.roomService.getRoomLifecycleTarget(room.roomId)
    if (!target.ok || target.value.hasConnectedHuman || this.#disposed) {
      this.#cancelRoomExpiration(room.roomId)
      return
    }
    const existing = this.#scheduledRoomExpirations.get(room.roomId)
    if (existing?.identity === target.value.identity) return
    this.#cancelRoomExpiration(room.roomId)
    this.#armRoomExpiration(room.roomId, target.value.identity, this.#lifecycleScheduler.now() + this.#expirationMs)
  }

  #armRoomExpiration(roomId: RoomId, identity: object, deadline: number): void {
    let scheduled!: ScheduledLifecycleExpiration
    const handle = this.#lifecycleScheduler.setTimeout(() => {
      void this.runRoomOperation(roomId, async () => {
        if (this.#scheduledRoomExpirations.get(roomId) !== scheduled || this.#disposed) return
        const target = this.roomService.getRoomLifecycleTarget(roomId)
        if (!target.ok || target.value.identity !== identity || target.value.hasConnectedHuman) {
          this.#cancelRoomExpiration(roomId)
          return
        }
        const remaining = deadline - this.#lifecycleScheduler.now()
        if (remaining > 0) {
          this.#lifecycleScheduler.clearTimeout(scheduled.handle)
          this.#armRoomExpiration(roomId, identity, deadline)
          return
        }
        this.#scheduledRoomExpirations.delete(roomId)
        const result = this.roomService.expireAbandonedRoom(roomId, identity)
        if (result.ok) await this.#afterRoomExpired(result.value)
      }).catch(() => undefined)
    }, Math.max(0, deadline - this.#lifecycleScheduler.now()))
    scheduled = { identity, deadline, handle }
    this.#scheduledRoomExpirations.set(roomId, scheduled)
  }

  #cancelRoomExpiration(roomId: RoomId): void {
    const scheduled = this.#scheduledRoomExpirations.get(roomId)
    if (!scheduled) return
    this.#lifecycleScheduler.clearTimeout(scheduled.handle)
    this.#scheduledRoomExpirations.delete(roomId)
  }

  #reconcileSessionExpiration(sessionId: string): void {
    const target = this.roomService.getSessionLifecycleTarget(sessionId)
    if (!target.ok || !target.value.isInactiveAndUnattached || this.#disposed) {
      this.#cancelSessionExpiration(sessionId)
      return
    }
    const existing = this.#scheduledSessionExpirations.get(sessionId)
    if (existing?.identity === target.value.identity) return
    this.#cancelSessionExpiration(sessionId)
    this.#armSessionExpiration(sessionId, target.value.identity, this.#lifecycleScheduler.now() + this.#expirationMs)
  }

  #reconcileSessionExpirations(sessionIds: Iterable<string>): void {
    for (const sessionId of new Set(sessionIds)) {
      try {
        this.#reconcileSessionExpiration(sessionId)
      } catch {
        this.#cancelSessionExpiration(sessionId)
      }
    }
  }

  #armSessionExpiration(sessionId: string, identity: object, deadline: number): void {
    let scheduled!: ScheduledLifecycleExpiration
    const handle = this.#lifecycleScheduler.setTimeout(() => {
      void this.#enqueue(`session:${sessionId}`, async () => {
        if (this.#scheduledSessionExpirations.get(sessionId) !== scheduled || this.#disposed) return
        const target = this.roomService.getSessionLifecycleTarget(sessionId)
        if (!target.ok || target.value.identity !== identity || !target.value.isInactiveAndUnattached) {
          this.#cancelSessionExpiration(sessionId)
          return
        }
        const remaining = deadline - this.#lifecycleScheduler.now()
        if (remaining > 0) {
          this.#lifecycleScheduler.clearTimeout(scheduled.handle)
          this.#armSessionExpiration(sessionId, identity, deadline)
          return
        }
        this.#scheduledSessionExpirations.delete(sessionId)
        const result = this.roomService.expireInactiveSession(sessionId, identity)
        if (result.ok) this.#afterSessionExpired(sessionId)
      }).catch(() => undefined)
    }, Math.max(0, deadline - this.#lifecycleScheduler.now()))
    scheduled = { identity, deadline, handle }
    this.#scheduledSessionExpirations.set(sessionId, scheduled)
  }

  #cancelSessionExpiration(sessionId: string): void {
    const scheduled = this.#scheduledSessionExpirations.get(sessionId)
    if (!scheduled) return
    this.#lifecycleScheduler.clearTimeout(scheduled.handle)
    this.#scheduledSessionExpirations.delete(sessionId)
  }

  async #afterRoomExpired(expiration: RoomExpiration): Promise<void> {
    this.#cancelRoomExpiration(expiration.roomId)
    this.cancelBotDecisions(expiration.roomId)
    for (const [sessionId, history] of this.#history) {
      for (const [commandId, entry] of history) {
        if (entry.roomId === expiration.roomId) history.delete(commandId)
      }
      if (history.size === 0) this.#history.delete(sessionId)
    }
    this.#reconcileSessionExpirations(expiration.detachedSessionIds)
    try {
      await this.#viewPort.roomExpired?.(expiration)
    } catch {
      // Subscription cleanup is best-effort and cannot restore an expired room.
    }
    try {
      await this.#viewPort.lobbyChanged()
    } catch {
      // Lobby publication can be retried independently of authoritative cleanup.
    }
  }

  #afterSessionExpired(sessionId: string): void {
    this.#cancelSessionExpiration(sessionId)
    this.#history.delete(sessionId)
  }

  #enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.#queues.set(key, current)
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release()
        if (this.#queues.get(key) === current) this.#queues.delete(key)
      })
  }
}
