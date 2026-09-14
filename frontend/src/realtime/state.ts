import type {
  ClientCommand,
  ChoiceId,
  CommandAcknowledgement,
  CommandError,
  CommandId,
  LobbySummary,
  RoomSnapshot,
  RoomUnavailable,
  SessionId,
  TileId,
} from '@cg-filipino-mahjong/shared'

type WithoutCommandId<T> = T extends unknown ? Omit<T, 'commandId'> : never

export type CommandDraft = WithoutCommandId<ClientCommand>
export type NonGameplayCommandDraft = Exclude<
  CommandDraft,
  { type: 'session.bootstrap' | 'game.action' }
>
export type GameplayCommandDraft = Extract<CommandDraft, { type: 'game.action' }>

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'superseded'
export type SessionStatus = 'anonymous' | 'restoring' | 'ready' | 'superseded'

export interface PendingCommand {
  readonly commandId: CommandId
  readonly type: ClientCommand['type']
  readonly startedAt: number
  readonly roomId?: string
  readonly handId?: string
  readonly phaseId?: string
}

export type RealtimeIssue =
  | {
    readonly kind: 'server'
    readonly commandId: CommandId | null
    readonly error: CommandError
  }
  | {
    readonly kind: 'transport' | 'protocol' | 'storage'
    readonly code: string
    readonly message: string
    readonly commandId?: CommandId
  }

export interface LocalHandState {
  readonly identity: string | null
  readonly tileOrder: readonly TileId[]
  readonly selectedTileId: TileId | null
}

interface RoomSwitchIntent {
  readonly roomCode?: string
}

export interface RealtimeState {
  readonly connectionStatus: ConnectionStatus
  readonly sessionStatus: SessionStatus
  readonly sessionId: SessionId | null
  readonly resumed: boolean
  readonly lobbyRooms: readonly LobbySummary[]
  readonly roomSnapshot: RoomSnapshot | null
  readonly roomError: RoomUnavailable | null
  readonly pendingCommands: Readonly<Record<string, PendingCommand>>
  readonly lastIssue: RealtimeIssue | null
  readonly isResynchronizing: boolean
  readonly localHand: LocalHandState
  readonly roomSwitchIntent: RoomSwitchIntent | null
  readonly retiredRoomIds: readonly string[]
}

export const INITIAL_REALTIME_STATE: RealtimeState = {
  connectionStatus: 'connecting',
  sessionStatus: 'anonymous',
  sessionId: null,
  resumed: false,
  lobbyRooms: [],
  roomSnapshot: null,
  roomError: null,
  pendingCommands: {},
  lastIssue: null,
  isResynchronizing: false,
  localHand: { identity: null, tileOrder: [], selectedTileId: null },
  roomSwitchIntent: null,
  retiredRoomIds: [],
}

export type GameplayCommandResult =
  | { readonly ok: true; readonly command: GameplayCommandDraft }
  | { readonly ok: false; readonly issue: RealtimeIssue }

export function gameplayCommandForChoice(state: RealtimeState, choiceId: ChoiceId): GameplayCommandResult {
  const snapshot = state.roomSnapshot
  if (
    state.connectionStatus !== 'connected'
    || state.sessionStatus !== 'ready'
    || state.isResynchronizing
    || snapshot?.stage !== 'playing'
    || !snapshot.self.canControl
    || snapshot.pause.isPaused
    || !snapshot.privateState
  ) {
    return { ok: false, issue: { kind: 'transport', code: 'gameplay-blocked', message: 'Gameplay is not currently available.' } }
  }
  if (Object.values(state.pendingCommands).some((pending) => (
    pending.type === 'game.action' && pending.phaseId === snapshot.phase.phaseId
  ))) {
    return { ok: false, issue: { kind: 'transport', code: 'gameplay-pending', message: 'Wait for the current action to be acknowledged.' } }
  }
  const choice = snapshot.privateState.legalChoices.find((candidate) => candidate.choiceId === choiceId)
  if (!choice) {
    return { ok: false, issue: { kind: 'transport', code: 'choice-not-legal', message: 'That choice is no longer offered in the current phase.' } }
  }
  const actionKind = choice.kind === 'pass' || choice.kind === 'chow' || choice.kind === 'pong' || choice.kind === 'open-kang'
    ? 'respond-to-discard'
    : choice.kind
  return {
    ok: true,
    command: {
      type: 'game.action',
      roomId: snapshot.roomId,
      handId: snapshot.handId,
      phaseId: snapshot.phase.phaseId,
      action: { kind: actionKind, choiceId },
    },
  }
}

export type RealtimeAction =
  | { readonly type: 'connecting'; readonly restoring: boolean; readonly resynchronizing?: boolean }
  | { readonly type: 'connected'; readonly restoring: boolean }
  | { readonly type: 'disconnected'; readonly issue?: RealtimeIssue }
  | { readonly type: 'session-ready'; readonly sessionId: SessionId; readonly resumed: boolean; readonly roomError?: RoomUnavailable }
  | { readonly type: 'anonymous' }
  | { readonly type: 'superseded' }
  | { readonly type: 'lobby-updated'; readonly rooms: readonly LobbySummary[] }
  | { readonly type: 'snapshot-received'; readonly snapshot: RoomSnapshot }
  | { readonly type: 'room-unavailable'; readonly event: RoomUnavailable }
  | { readonly type: 'command-pending'; readonly pending: PendingCommand; readonly roomSwitchIntent?: RoomSwitchIntent }
  | { readonly type: 'command-finished'; readonly command: ClientCommand; readonly acknowledgement: CommandAcknowledgement }
  | { readonly type: 'command-abandoned'; readonly commandId: CommandId; readonly issue: RealtimeIssue }
  | { readonly type: 'issue'; readonly issue: RealtimeIssue }
  | { readonly type: 'clear-issue' }
  | { readonly type: 'resynchronizing' }
  | { readonly type: 'select-tile'; readonly tileId: TileId | null }
  | { readonly type: 'set-tile-order'; readonly tileIds: readonly TileId[] }

function handIdentity(snapshot: RoomSnapshot): string | null {
  if (snapshot.stage !== 'playing' || !snapshot.privateState || !snapshot.self.canControl) return null
  return `${snapshot.roomId}:${snapshot.handId}:${snapshot.privateState.seat}`
}

function reconcileLocalHand(current: LocalHandState, snapshot: RoomSnapshot): LocalHandState {
  const identity = handIdentity(snapshot)
  if (!identity || snapshot.stage !== 'playing' || !snapshot.privateState) {
    return { identity: null, tileOrder: [], selectedTileId: null }
  }
  const tileIds = snapshot.privateState.concealedTiles.map((tile) => tile.tileId)
  const available = new Set(tileIds)
  const tileOrder = current.identity === identity
    ? [...current.tileOrder.filter((tileId) => available.has(tileId)), ...tileIds.filter((tileId) => !current.tileOrder.includes(tileId))]
    : tileIds
  return {
    identity,
    tileOrder,
    selectedTileId: current.identity === identity && current.selectedTileId && available.has(current.selectedTileId)
      ? current.selectedTileId
      : null,
  }
}

function gameRevision(snapshot: RoomSnapshot): number | null {
  return snapshot.stage === 'waiting' ? null : snapshot.gameRevision
}

function handId(snapshot: RoomSnapshot): string | null {
  return snapshot.stage === 'waiting' ? null : snapshot.handId
}

export function isNewerSnapshot(
  current: RoomSnapshot | null,
  incoming: RoomSnapshot,
  intent: RoomSwitchIntent | null,
  retiredRoomIds: readonly string[],
): boolean {
  if (!current) {
    if (retiredRoomIds.includes(incoming.roomId) && intent?.roomCode !== incoming.roomCode) return false
    return !intent?.roomCode || intent.roomCode === incoming.roomCode
  }
  if (current.roomId !== incoming.roomId) {
    if (retiredRoomIds.includes(incoming.roomId) && intent?.roomCode !== incoming.roomCode) return false
    return Boolean(intent && (!intent.roomCode || intent.roomCode === incoming.roomCode))
  }
  if (incoming.roomRevision < current.roomRevision) return false
  const currentHandId = handId(current)
  const incomingHandId = handId(incoming)
  const currentGameRevision = gameRevision(current)
  const incomingGameRevision = gameRevision(incoming)
  if (
    currentHandId !== null
    && currentHandId === incomingHandId
    && currentGameRevision !== null
    && incomingGameRevision !== null
    && incomingGameRevision < currentGameRevision
  ) return false
  return incoming.roomRevision > current.roomRevision
    || currentHandId !== incomingHandId
    || currentGameRevision !== incomingGameRevision
}

function receiveSnapshot(state: RealtimeState, snapshot: RoomSnapshot): RealtimeState {
  if (!isNewerSnapshot(state.roomSnapshot, snapshot, state.roomSwitchIntent, state.retiredRoomIds)) return state
  const switched = state.roomSnapshot && state.roomSnapshot.roomId !== snapshot.roomId
  const retiredRoomIds = switched && !state.retiredRoomIds.includes(state.roomSnapshot!.roomId)
    ? [...state.retiredRoomIds, state.roomSnapshot!.roomId]
    : state.retiredRoomIds
  return {
    ...state,
    roomSnapshot: snapshot,
    roomError: null,
    isResynchronizing: false,
    roomSwitchIntent: null,
    retiredRoomIds,
    localHand: reconcileLocalHand(state.localHand, snapshot),
  }
}

function withoutPending(state: RealtimeState, commandId: CommandId) {
  const pendingCommands = { ...state.pendingCommands }
  delete pendingCommands[commandId]
  return pendingCommands
}

export function realtimeReducer(state: RealtimeState, action: RealtimeAction): RealtimeState {
  switch (action.type) {
    case 'connecting':
      return {
        ...state,
        connectionStatus: 'connecting',
        sessionStatus: action.restoring ? 'restoring' : 'anonymous',
        isResynchronizing: action.resynchronizing ?? state.isResynchronizing,
      }
    case 'connected':
      return {
        ...state,
        connectionStatus: 'connected',
        sessionStatus: action.restoring ? 'restoring' : state.sessionId ? 'ready' : 'anonymous',
      }
    case 'disconnected':
      if (state.connectionStatus === 'superseded') return state
      return { ...state, connectionStatus: 'disconnected', ...(action.issue ? { lastIssue: action.issue } : {}) }
    case 'anonymous':
      return {
        ...INITIAL_REALTIME_STATE,
        connectionStatus: state.connectionStatus,
        retiredRoomIds: state.roomSnapshot
          ? [...state.retiredRoomIds, state.roomSnapshot.roomId]
          : state.retiredRoomIds,
      }
    case 'session-ready':
      return {
        ...state,
        connectionStatus: 'connected',
        sessionStatus: 'ready',
        sessionId: action.sessionId,
        resumed: action.resumed,
        roomError: action.roomError ?? null,
        ...(action.roomError ? {
          roomSnapshot: null,
          localHand: INITIAL_REALTIME_STATE.localHand,
          retiredRoomIds: state.roomSnapshot && !state.retiredRoomIds.includes(state.roomSnapshot.roomId)
            ? [...state.retiredRoomIds, state.roomSnapshot.roomId]
            : state.retiredRoomIds,
        } : {}),
      }
    case 'superseded':
      return {
        ...state,
        connectionStatus: 'superseded',
        sessionStatus: 'superseded',
        pendingCommands: {},
        isResynchronizing: false,
        lastIssue: { kind: 'transport', code: 'session-superseded', message: 'This session is active in a newer connection.' },
      }
    case 'lobby-updated':
      return { ...state, lobbyRooms: action.rooms, isResynchronizing: false }
    case 'snapshot-received':
      return receiveSnapshot(state, action.snapshot)
    case 'room-unavailable': {
      const retiredRoomIds = state.roomSnapshot && !state.retiredRoomIds.includes(state.roomSnapshot.roomId)
        ? [...state.retiredRoomIds, state.roomSnapshot.roomId]
        : state.retiredRoomIds
      return {
        ...state,
        roomSnapshot: null,
        roomError: action.event,
        retiredRoomIds,
        localHand: INITIAL_REALTIME_STATE.localHand,
        isResynchronizing: false,
      }
    }
    case 'command-pending':
      return {
        ...state,
        pendingCommands: { ...state.pendingCommands, [action.pending.commandId]: action.pending },
        roomSwitchIntent: action.roomSwitchIntent ?? state.roomSwitchIntent,
        lastIssue: null,
      }
    case 'command-finished': {
      let next = { ...state, pendingCommands: withoutPending(state, action.command.commandId) }
      if (action.acknowledgement.status === 'rejected') {
        next = {
          ...next,
          lastIssue: { kind: 'server', commandId: action.acknowledgement.commandId, error: action.acknowledgement.error },
          roomSwitchIntent: null,
        }
        if (action.acknowledgement.snapshot) next = receiveSnapshot(next, action.acknowledgement.snapshot)
        return next
      }
      const result = action.acknowledgement.result
      if (result.kind === 'lobby-rooms') next = { ...next, lobbyRooms: result.rooms, isResynchronizing: false }
      if (result.kind === 'room-snapshot') next = receiveSnapshot(next, result.snapshot)
      if (action.command.type === 'room.leave') {
        const retiredRoomIds = state.roomSnapshot && !state.retiredRoomIds.includes(state.roomSnapshot.roomId)
          ? [...state.retiredRoomIds, state.roomSnapshot.roomId]
          : state.retiredRoomIds
        next = { ...next, roomSnapshot: null, roomSwitchIntent: null, retiredRoomIds, localHand: INITIAL_REALTIME_STATE.localHand }
      }
      return next
    }
    case 'command-abandoned':
      return { ...state, pendingCommands: withoutPending(state, action.commandId), lastIssue: action.issue }
    case 'issue':
      return { ...state, lastIssue: action.issue }
    case 'clear-issue':
      return { ...state, lastIssue: null, roomError: null }
    case 'resynchronizing':
      return { ...state, isResynchronizing: true }
    case 'select-tile':
      return state.localHand.tileOrder.includes(action.tileId as TileId)
        ? { ...state, localHand: { ...state.localHand, selectedTileId: action.tileId } }
        : action.tileId === null
          ? { ...state, localHand: { ...state.localHand, selectedTileId: null } }
          : state
    case 'set-tile-order': {
      const existing = new Set(state.localHand.tileOrder)
      if (action.tileIds.length !== existing.size || action.tileIds.some((tileId) => !existing.has(tileId))) return state
      return { ...state, localHand: { ...state.localHand, tileOrder: [...action.tileIds] } }
    }
  }
}
