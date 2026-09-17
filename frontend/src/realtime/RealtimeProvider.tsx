/* oxlint-disable react/only-export-components -- Provider hooks and test seam intentionally share its private contexts. */

import {
  ClientCommandSchema,
  CommandAcknowledgementSchema,
  CommandErrorSchema,
  LobbyUpdatedSchema,
  ReconnectCredentialSchema,
  RoomSnapshotSchema,
  RoomUnavailableSchema,
  SessionReadySchema,
  SessionSupersededSchema,
  type ChoiceId,
  type ClientCommand,
  type CommandAcknowledgement,
  type CommandId,
  type RoomCode,
  type RoomEntrySummary,
  type RoomUnavailable,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type TileId,
} from '@cg-filipino-mahjong/shared'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { io, type Socket } from 'socket.io-client'

import {
  INITIAL_REALTIME_STATE,
  gameplayCommandForChoice,
  realtimeReducer,
  type CommandDraft,
  type NonGameplayCommandDraft,
  type PendingCommand,
  type RealtimeAction,
  type RealtimeIssue,
  type RealtimeState,
} from './state.ts'
import {
  HAND_ORDER_STORAGE_KEY,
  persistHandOrder,
  readPersistedHandOrder,
} from './handArrangement.ts'

export const RECONNECT_CREDENTIAL_STORAGE_KEY = 'cg-filipino-mahjong.reconnectCredential.v1'
export const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface RealtimeProviderProps {
  readonly children: ReactNode
  readonly socketFactory?: (auth: () => Record<string, unknown>) => TypedSocket
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  readonly handOrderStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  readonly acknowledgementTimeoutMs?: number
  readonly createCommandId?: () => string
  readonly now?: () => number
}

interface PendingResolution {
  readonly command: ClientCommand
  readonly resolve: (acknowledgement: CommandAcknowledgement) => void
  readonly reject: (error: RealtimeCommandError) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

class CredentialHolder {
  #value: string | null

  constructor(value: string | null) {
    this.#value = value
  }

  get(): string | null {
    return this.#value
  }

  set(value: string | null): void {
    this.#value = value
  }
}

export class RealtimeCommandError extends Error {
  readonly issue: RealtimeIssue

  constructor(issue: RealtimeIssue) {
    super(issue.kind === 'server' ? issue.error.message : issue.message)
    this.name = 'RealtimeCommandError'
    this.issue = issue
  }
}

export interface RealtimeActions {
  bootstrapSession(displayName: string): Promise<CommandAcknowledgement>
  inspectRoom(roomCode: RoomCode): Promise<RoomEntrySummary>
  sendCommand(command: NonGameplayCommandDraft): Promise<CommandAcknowledgement>
  submitGameplayChoice(choiceId: ChoiceId): Promise<CommandAcknowledgement>
  resynchronize(): void
  clearIssue(): void
  clearDeparture(): void
  selectTile(tileId: TileId | null): void
  setTileOrder(tileIds: readonly TileId[]): void
}

const StateContext = createContext<RealtimeState | null>(null)
const ActionsContext = createContext<RealtimeActions | null>(null)

function defaultSocketFactory(auth: () => Record<string, unknown>): TypedSocket {
  return io({ autoConnect: false, auth: (setAuth) => setAuth(auth()) })
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function browserHandOrderStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function readCredential(storage: RealtimeProviderProps['storage']): string | null {
  if (!storage) return null
  try {
    const stored = storage.getItem(RECONNECT_CREDENTIAL_STORAGE_KEY)
    if (stored === null) return null
    const parsed = ReconnectCredentialSchema.safeParse(stored)
    if (parsed.success) return parsed.data
    storage.removeItem(RECONNECT_CREDENTIAL_STORAGE_KEY)
    return null
  } catch {
    return null
  }
}

function roomSwitchIntent(command: ClientCommand): { roomCode?: string } | undefined {
  if (command.type === 'room.create') return {}
  if (command.type === 'room.join' || command.type === 'room.takeover') {
    return { roomCode: command.roomCode }
  }
  return undefined
}

function pendingMetadata(command: ClientCommand, startedAt: number, roomUnavailableVersion = 0): PendingCommand {
  return {
    commandId: command.commandId,
    type: command.type,
    startedAt,
    roomUnavailableVersion,
    ...('roomId' in command ? { roomId: command.roomId } : {}),
    ...(command.type === 'game.action' ? { handId: command.handId, phaseId: command.phaseId } : {}),
  }
}

function gameplayAdvanced(pending: PendingCommand, state: RealtimeState): boolean {
  if (pending.type !== 'game.action') return false
  const snapshot = state.roomSnapshot
  return snapshot?.stage !== 'playing'
    || snapshot.roomId !== pending.roomId
    || snapshot.handId !== pending.handId
    || snapshot.phase.phaseId !== pending.phaseId
}

export function attachRealtimeListeners(
  socket: TypedSocket,
  handlers: {
    readonly connect: () => void
    readonly disconnect: (reason: string) => void
    readonly connectError: (error: Error) => void
    readonly sessionReady: (value: unknown) => void
    readonly lobbyUpdated: (value: unknown) => void
    readonly roomSnapshot: (value: unknown) => void
    readonly roomUnavailable: (value: unknown) => void
    readonly sessionSuperseded: (value: unknown) => void
  },
): () => void {
  socket.on('connect', handlers.connect)
  socket.on('disconnect', handlers.disconnect)
  socket.on('connect_error', handlers.connectError)
  socket.on('session.ready', handlers.sessionReady)
  socket.on('lobby.updated', handlers.lobbyUpdated)
  socket.on('room.snapshot', handlers.roomSnapshot)
  socket.on('room.unavailable', handlers.roomUnavailable)
  socket.on('session.superseded', handlers.sessionSuperseded)
  return () => {
    socket.off('connect', handlers.connect)
    socket.off('disconnect', handlers.disconnect)
    socket.off('connect_error', handlers.connectError)
    socket.off('session.ready', handlers.sessionReady)
    socket.off('lobby.updated', handlers.lobbyUpdated)
    socket.off('room.snapshot', handlers.roomSnapshot)
    socket.off('room.unavailable', handlers.roomUnavailable)
    socket.off('session.superseded', handlers.sessionSuperseded)
  }
}

export function RealtimeProvider({
  children,
  socketFactory = defaultSocketFactory,
  storage: suppliedStorage,
  handOrderStorage: suppliedHandOrderStorage,
  acknowledgementTimeoutMs = DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS,
  createCommandId = () => crypto.randomUUID(),
  now = () => Date.now(),
}: RealtimeProviderProps) {
  const storage = useMemo(() => suppliedStorage ?? browserStorage(), [suppliedStorage])
  const handOrderStorage = useMemo(
    () => suppliedHandOrderStorage ?? browserHandOrderStorage(),
    [suppliedHandOrderStorage],
  )
  const initialCredential = useMemo(() => readCredential(storage), [storage])
  const initialHandOrder = useMemo(() => readPersistedHandOrder(handOrderStorage), [handOrderStorage])
  const [credential] = useState(() => new CredentialHolder(initialCredential))
  const [socket] = useState(() => socketFactory(() => credential.get()
    ? { reconnectCredential: credential.get() }
    : {}))
  const [state, reactDispatch] = useReducer(realtimeReducer, {
    ...INITIAL_REALTIME_STATE,
    sessionStatus: initialCredential ? 'restoring' : 'anonymous',
    localHand: initialCredential && initialHandOrder
      ? { ...initialHandOrder, selectedTileId: null }
      : INITIAL_REALTIME_STATE.localHand,
  })
  const stateRef = useRef(state)
  const previousHandIdentityRef = useRef(state.localHand.identity)
  const pendingRef = useRef(new Map<CommandId, PendingResolution>())
  const invalidCredentialRetriedRef = useRef(false)

  useEffect(() => {
    if (state.localHand.identity) {
      persistHandOrder(handOrderStorage, {
        identity: state.localHand.identity,
        tileOrder: state.localHand.tileOrder,
      })
    } else if (previousHandIdentityRef.current || !initialCredential) {
      try {
        handOrderStorage?.removeItem(HAND_ORDER_STORAGE_KEY)
      } catch {
        // Browser privacy settings can make storage unavailable at any time.
      }
    }
    previousHandIdentityRef.current = state.localHand.identity
  }, [handOrderStorage, initialCredential, state.localHand])

  const dispatch = useCallback((action: RealtimeAction) => {
    stateRef.current = realtimeReducer(stateRef.current, action)
    reactDispatch(action)
  }, [])

  const rejectAllPending = useCallback((issue: RealtimeIssue) => {
    for (const [commandId, pending] of pendingRef.current) {
      clearTimeout(pending.timeout)
      pending.reject(new RealtimeCommandError({ ...issue, commandId }))
      dispatch({ type: 'command-abandoned', commandId, issue: { ...issue, commandId } })
    }
    pendingRef.current.clear()
  }, [dispatch])

  const rejectPendingRoomCommands = useCallback((event: RoomUnavailable) => {
    const roomCode = stateRef.current.roomSnapshot?.roomCode ?? stateRef.current.roomSwitchIntent?.roomCode
    for (const [commandId, pending] of pendingRef.current) {
      if (pending.command.type !== 'room.inspect'
        && pending.command.type !== 'room.join'
        && pending.command.type !== 'room.takeover') continue
      if (roomCode && pending.command.roomCode !== roomCode) continue
      pendingRef.current.delete(commandId)
      clearTimeout(pending.timeout)
      const issue: RealtimeIssue = { kind: 'server', commandId, error: event }
      pending.reject(new RealtimeCommandError(issue))
      dispatch({ type: 'command-abandoned', commandId, issue })
    }
  }, [dispatch])

  const resynchronize = useCallback(() => {
    if (stateRef.current.connectionStatus === 'superseded') return
    dispatch({ type: 'resynchronizing' })
    socket.disconnect()
    dispatch({ type: 'connecting', restoring: Boolean(credential.get()), resynchronizing: true })
    socket.connect()
  }, [credential, dispatch, socket])

  useEffect(() => {
    const protocolIssue = (event: string): RealtimeIssue => ({
      kind: 'protocol',
      code: 'invalid-server-payload',
      message: `The server sent an invalid ${event} payload.`,
    })
    const handlers = {
      connect: () => dispatch({ type: 'connected', restoring: Boolean(credential.get()) }),
      disconnect: (reason: string) => {
        if (stateRef.current.connectionStatus === 'superseded') return
        rejectAllPending({ kind: 'transport', code: 'disconnected', message: `Connection closed: ${reason}.` })
        dispatch({ type: 'disconnected' })
      },
      connectError: (error: Error) => {
        const data = 'data' in error ? error.data : undefined
        const parsed = CommandErrorSchema.safeParse(data)
        if (parsed.success && parsed.data.code === 'invalid-session' && credential.get() && !invalidCredentialRetriedRef.current) {
          invalidCredentialRetriedRef.current = true
          credential.set(null)
          try {
            storage?.removeItem(RECONNECT_CREDENTIAL_STORAGE_KEY)
          } catch {
            dispatch({ type: 'issue', issue: { kind: 'storage', code: 'credential-remove-failed', message: 'The expired session credential could not be removed.' } })
          }
          dispatch({ type: 'anonymous' })
          socket.connect()
          return
        }
        const issue: RealtimeIssue = parsed.success
          ? { kind: 'server', commandId: null, error: parsed.data }
          : { kind: 'transport', code: 'connection-error', message: error.message || 'The server could not be reached.' }
        rejectAllPending(issue)
        dispatch({ type: 'disconnected', issue })
      },
      sessionReady: (value: unknown) => {
        const parsed = SessionReadySchema.safeParse(value)
        if (!parsed.success) return dispatch({ type: 'issue', issue: protocolIssue('session.ready') })
        dispatch({ type: 'session-ready', ...parsed.data })
      },
      lobbyUpdated: (value: unknown) => {
        const parsed = LobbyUpdatedSchema.safeParse(value)
        if (!parsed.success) return dispatch({ type: 'issue', issue: protocolIssue('lobby.updated') })
        dispatch({ type: 'lobby-updated', rooms: parsed.data.rooms })
      },
      roomSnapshot: (value: unknown) => {
        const parsed = RoomSnapshotSchema.safeParse(value)
        if (!parsed.success) return dispatch({ type: 'issue', issue: protocolIssue('room.snapshot') })
        dispatch({ type: 'snapshot-received', snapshot: parsed.data })
      },
      roomUnavailable: (value: unknown) => {
        const parsed = RoomUnavailableSchema.safeParse(value)
        if (!parsed.success) return dispatch({ type: 'issue', issue: protocolIssue('room.unavailable') })
        rejectPendingRoomCommands(parsed.data)
        dispatch({ type: 'room-unavailable', event: parsed.data })
      },
      sessionSuperseded: (value: unknown) => {
        const parsed = SessionSupersededSchema.safeParse(value)
        if (!parsed.success) return dispatch({ type: 'issue', issue: protocolIssue('session.superseded') })
        rejectAllPending({ kind: 'transport', code: 'session-superseded', message: 'This session is active in a newer connection.' })
        dispatch({ type: 'superseded' })
        socket.disconnect()
      },
    }
    const detach = attachRealtimeListeners(socket, handlers)
    dispatch({ type: 'connecting', restoring: Boolean(credential.get()) })
    socket.connect()
    return () => {
      detach()
      rejectAllPending({ kind: 'transport', code: 'provider-unmounted', message: 'The realtime provider was closed.' })
      socket.disconnect()
    }
  }, [credential, dispatch, rejectAllPending, rejectPendingRoomCommands, socket, storage])

  const failCommand = useCallback((issue: RealtimeIssue): Promise<CommandAcknowledgement> => {
    dispatch({ type: 'issue', issue })
    return Promise.reject(new RealtimeCommandError(issue))
  }, [dispatch])

  const sendDraft = useCallback((draft: CommandDraft): Promise<CommandAcknowledgement> => {
    const current = stateRef.current
    if (draft.type === 'room.leave' && Object.values(current.pendingCommands).some((pending) => (
      pending.type === 'room.leave' && pending.roomId === draft.roomId
    ))) {
      return failCommand({ kind: 'transport', code: 'departure-pending', message: 'Your departure request is already being processed.' })
    }
    if (!socket.connected || current.connectionStatus !== 'connected') {
      return failCommand({ kind: 'transport', code: 'disconnected', message: 'Connect before sending a command.' })
    }
    if (current.isResynchronizing) {
      return failCommand({ kind: 'transport', code: 'resynchronizing', message: 'Wait for authoritative state to be restored.' })
    }
    if (current.sessionStatus === 'superseded') {
      return failCommand({ kind: 'transport', code: 'session-superseded', message: 'This session is active in a newer connection.' })
    }
    const parsed = ClientCommandSchema.safeParse({ ...draft, commandId: createCommandId() })
    if (!parsed.success) {
      return failCommand({ kind: 'protocol', code: 'invalid-command', message: 'The command does not match the shared contract.' })
    }
    const command = parsed.data
    const commandId = command.commandId
    dispatch({
      type: 'command-pending',
      pending: pendingMetadata(command, now(), current.roomUnavailableVersion),
      roomSwitchIntent: roomSwitchIntent(command),
    })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingRef.current.get(commandId)
        if (!pending) return
        pendingRef.current.delete(commandId)
        const issue: RealtimeIssue = {
          kind: 'transport',
          code: 'acknowledgement-timeout',
          message: 'The server did not acknowledge the command in time.',
          commandId,
        }
        dispatch({ type: 'command-abandoned', commandId, issue })
        reject(new RealtimeCommandError(issue))
        if (!gameplayAdvanced(pendingMetadata(command, 0), stateRef.current)) resynchronize()
      }, acknowledgementTimeoutMs)
      pendingRef.current.set(commandId, { command, resolve, reject, timeout })
      socket.volatile.emit('command', command, (value: unknown) => {
        const pending = pendingRef.current.get(commandId)
        if (!pending) return
        clearTimeout(pending.timeout)
        pendingRef.current.delete(commandId)
        const acknowledgement = CommandAcknowledgementSchema.safeParse(value)
        if (!acknowledgement.success || acknowledgement.data.commandId !== commandId) {
          const issue: RealtimeIssue = {
            kind: 'protocol',
            code: 'invalid-acknowledgement',
            message: 'The server returned an invalid command acknowledgement.',
            commandId,
          }
          dispatch({ type: 'command-abandoned', commandId, issue })
          pending.reject(new RealtimeCommandError(issue))
          resynchronize()
          return
        }
        const acknowledged = acknowledgement.data
        if (acknowledged.status === 'accepted' && acknowledged.result.kind === 'session-bootstrapped') {
          credential.set(acknowledged.result.reconnectCredential)
          try {
            storage?.setItem(RECONNECT_CREDENTIAL_STORAGE_KEY, acknowledged.result.reconnectCredential)
          } catch {
            dispatch({ type: 'issue', issue: { kind: 'storage', code: 'credential-save-failed', message: 'This guest session cannot be restored after a reload.' } })
          }
        }
        dispatch({ type: 'command-finished', command, acknowledgement: acknowledged })
        pending.resolve(acknowledged)
        if (
          command.type === 'room.leave'
          && acknowledged.status === 'accepted'
          && acknowledged.result.kind === 'room-departure'
          && acknowledged.result.disposition === 'reserved'
        ) resynchronize()
      })
    })
  }, [acknowledgementTimeoutMs, createCommandId, credential, dispatch, failCommand, now, resynchronize, socket, storage])

  const bootstrapSession = useCallback((displayName: string) => {
    if (stateRef.current.sessionStatus !== 'anonymous') {
      return failCommand({ kind: 'transport', code: 'session-already-ready', message: 'This connection already controls a guest session.' })
    }
    return sendDraft({ type: 'session.bootstrap', displayName })
  }, [failCommand, sendDraft])

  const sendCommand = useCallback((command: NonGameplayCommandDraft) => {
    if (stateRef.current.sessionStatus !== 'ready') {
      return failCommand({ kind: 'transport', code: 'session-not-ready', message: 'Restore or create a guest session first.' })
    }
    return sendDraft(command)
  }, [failCommand, sendDraft])

  const inspectRoom = useCallback(async (roomCode: RoomCode): Promise<RoomEntrySummary> => {
    const acknowledgement = await sendCommand({ type: 'room.inspect', roomCode })
    if (acknowledgement.status === 'rejected') {
      throw new RealtimeCommandError({
        kind: 'server',
        commandId: acknowledgement.commandId,
        error: acknowledgement.error,
      })
    }
    if (acknowledgement.result.kind !== 'room-entry') {
      const issue: RealtimeIssue = {
        kind: 'protocol',
        code: 'unexpected-room-entry-result',
        message: 'The server returned an unexpected room entry result.',
        commandId: acknowledgement.commandId,
      }
      dispatch({ type: 'issue', issue })
      throw new RealtimeCommandError(issue)
    }
    return acknowledgement.result.entry
  }, [dispatch, sendCommand])

  const submitGameplayChoice = useCallback((choiceId: ChoiceId) => {
    const result = gameplayCommandForChoice(stateRef.current, choiceId)
    return result.ok ? sendDraft(result.command) : failCommand(result.issue)
  }, [failCommand, sendDraft])

  const actions = useMemo<RealtimeActions>(() => ({
    bootstrapSession,
    inspectRoom,
    sendCommand,
    submitGameplayChoice,
    resynchronize,
    clearIssue: () => dispatch({ type: 'clear-issue' }),
    clearDeparture: () => dispatch({ type: 'departure-redirected' }),
    selectTile: (tileId) => dispatch({ type: 'select-tile', tileId }),
    setTileOrder: (tileIds) => dispatch({ type: 'set-tile-order', tileIds }),
  }), [bootstrapSession, dispatch, inspectRoom, resynchronize, sendCommand, submitGameplayChoice])

  return (
    <StateContext value={state}>
      <ActionsContext value={actions}>{children}</ActionsContext>
    </StateContext>
  )
}

export function useRealtimeState(): RealtimeState {
  const value = useContext(StateContext)
  if (!value) throw new Error('useRealtimeState must be used inside RealtimeProvider.')
  return value
}

export function useRealtimeActions(): RealtimeActions {
  const value = useContext(ActionsContext)
  if (!value) throw new Error('useRealtimeActions must be used inside RealtimeProvider.')
  return value
}

export function useRoomState() {
  const { roomSnapshot, roomError, isResynchronizing } = useRealtimeState()
  return { roomSnapshot, roomError, isResynchronizing }
}

export function useLocalHandState() {
  const { localHand } = useRealtimeState()
  const { selectTile, setTileOrder } = useRealtimeActions()
  return { ...localHand, selectTile, setTileOrder }
}
