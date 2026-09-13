import {
  ClientCommandSchema,
  CommandIdSchema,
  type ClientCommand,
  type CommandAcknowledgement,
  type CommandError,
  type CommandId,
  type CommandResult,
  type ProposalCreateCommand,
  type ProposalVoteCommand,
  type RoomSnapshot,
  type RoomId,
  type RoomTakeoverCommand,
} from '@cg-filipino-mahjong/shared'

import {
  RoomService,
  type RoomServiceResult,
  type RoomState,
  type SessionAuthentication,
  type SessionControl,
} from '../room-service/index.js'

type FutureCommand = ProposalCreateCommand | ProposalVoteCommand | RoomTakeoverCommand

export interface RealtimeViewPort {
  snapshotFor(control: SessionControl, room: RoomState): Promise<RoomSnapshot | undefined> | RoomSnapshot | undefined
  roomChanged(room: RoomState): Promise<void> | void
  lobbyChanged(): Promise<void> | void
}

export interface FutureCommandContext {
  readonly control: SessionControl
  readonly command: FutureCommand
}

export interface FutureCommandOutcome {
  readonly result: CommandResult
  readonly room?: RoomState
}

export type FutureCommandHandler = (
  context: FutureCommandContext,
) => Promise<RoomServiceResult<FutureCommandOutcome>> | RoomServiceResult<FutureCommandOutcome>

export interface RealtimeCoordinatorOptions {
  readonly roomService?: RoomService
  readonly viewPort?: RealtimeViewPort
  readonly futureCommandHandler?: FutureCommandHandler
  readonly commandHistoryLimit?: number
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
}

const noViews: RealtimeViewPort = {
  snapshotFor: () => undefined,
  roomChanged: () => undefined,
  lobbyChanged: () => undefined,
}

const unavailableFutureCommand: FutureCommandHandler = () => ({
  ok: false,
  error: {
    code: 'action-not-legal',
    message: 'This command is not available yet.',
  },
})

function validLimit(value: number | undefined): number {
  const resolved = value ?? 256
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('commandHistoryLimit must be a positive safe integer.')
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
  readonly #futureCommandHandler: FutureCommandHandler
  readonly #commandHistoryLimit: number
  readonly #history = new Map<string, Map<CommandId, HistoryEntry>>()
  readonly #queues = new Map<string, Promise<void>>()

  constructor(options: RealtimeCoordinatorOptions = {}) {
    this.roomService = options.roomService ?? new RoomService()
    this.#viewPort = options.viewPort ?? noViews
    this.#futureCommandHandler = options.futureCommandHandler ?? unavailableFutureCommand
    this.#commandHistoryLimit = validLimit(options.commandHistoryLimit)
  }

  authenticate(credential: string, controllerId: string): Promise<RoomServiceResult<SessionAuthentication>> {
    const target = this.roomService.resolveReconnectTarget(credential)
    if (!target.ok) return Promise.resolve(target)
    return this.#enqueue(`session:${target.value.sessionId}`, async () => {
      const authenticate = async () => {
        const result = this.roomService.authenticate(credential, controllerId)
        if (result.ok && result.value.room) {
          await this.#notifyRoomChanged(result.value.room)
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

  async disconnect(control: SessionControl): Promise<void> {
    await this.#enqueue(`session:${control.sessionId}`, async () => {
      const controlledRoom = this.roomService.getControlledRoom(control)
      const disconnect = () => Promise.resolve(this.roomService.disconnect(control))
      const result = controlledRoom.ok && controlledRoom.value
        ? await this.runRoomOperation(controlledRoom.value.roomId, disconnect)
        : await disconnect()
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

    if (command.type === 'proposal.create' || command.type === 'proposal.vote' || command.type === 'room.takeover') {
      const takeoverRoom = command.type === 'room.takeover'
        ? this.roomService.resolveRoomId(command.roomCode)
        : null
      const queueKey = 'roomId' in command
        ? `room:${command.roomId}`
        : takeoverRoom?.ok
          ? `room:${takeoverRoom.value}`
          : `takeover:${command.roomCode}`
      return this.#enqueue(queueKey, async () => {
        const handled = await this.#futureCommandHandler({ control, command })
        if (!handled.ok) return { acknowledgement: rejected(command.commandId, handled.error) }
        if (handled.value.room) {
          await this.#notifyRoomChanged(handled.value.room)
        }
        return {
          acknowledgement: accepted(command.commandId, handled.value.result),
          room: handled.value.room,
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
      await this.#viewPort.roomChanged(room)
    } catch {
      // Publishing is downstream of the authoritative commit and must not change its acknowledgement.
    }
    try {
      await this.#viewPort.lobbyChanged()
    } catch {
      // BACKEND-009 can retry publication without replaying the committed command.
    }
  }

  #finish(
    control: SessionControl,
    command: ClientCommand,
    commandFingerprint: string,
    result: CommandHandlingResult,
  ): CommandHandlingResult {
    this.#remember(control.sessionId, command.commandId, commandFingerprint, result.acknowledgement)
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
  ): void {
    let history = this.#history.get(sessionId)
    if (!history) {
      history = new Map()
      this.#history.set(sessionId, history)
    }
    history.set(commandId, { fingerprint: commandFingerprint, acknowledgement })
    while (history.size > this.#commandHistoryLimit) {
      const oldest = history.keys().next().value
      if (oldest === undefined) break
      history.delete(oldest)
    }
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
