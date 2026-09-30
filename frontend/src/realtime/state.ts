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
import { sortedTileIds } from './handArrangement.ts'

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
  readonly roomUnavailableVersion?: number
}

export function isRoomMembershipCommand(type: ClientCommand['type']): boolean {
  return type === 'room.create'
    || type === 'room.join'
    || type === 'room.spectate'
    || type === 'room.takeover'
    || type === 'room.leave'
}

export function hasPendingRoomMembershipCommand(pendingCommands: Readonly<Record<string, PendingCommand>>): boolean {
  return Object.values(pendingCommands).some((pending) => isRoomMembershipCommand(pending.type))
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

interface DepartureState {
  readonly roomId: string
  readonly roomCode: string
  readonly roomRevision: number
  readonly status: 'pending' | 'uncertain' | 'detached'
}

export interface RealtimeState {
  readonly connectionStatus: ConnectionStatus
  readonly sessionStatus: SessionStatus
  readonly sessionId: SessionId | null
  readonly resumed: boolean
  readonly lobbyRooms: readonly LobbySummary[]
  readonly hasReceivedLobby: boolean
  readonly roomSnapshot: RoomSnapshot | null
  readonly roomError: RoomUnavailable | null
  readonly pendingCommands: Readonly<Record<string, PendingCommand>>
  readonly lastIssue: RealtimeIssue | null
  readonly isResynchronizing: boolean
  readonly localHand: LocalHandState
  readonly autoSortHand: boolean
  readonly roomSwitchIntent: RoomSwitchIntent | null
  readonly retiredRoomIds: readonly string[]
  readonly retiredRoomRevisions: Readonly<Record<string, number>>
  readonly departure: DepartureState | null
  readonly terminalRoomIds: readonly string[]
  readonly roomUnavailableVersion: number
}

export const INITIAL_REALTIME_STATE: RealtimeState = {
  connectionStatus: 'connecting',
  sessionStatus: 'anonymous',
  sessionId: null,
  resumed: false,
  lobbyRooms: [],
  hasReceivedLobby: false,
  roomSnapshot: null,
  roomError: null,
  pendingCommands: {},
  lastIssue: null,
  isResynchronizing: false,
  localHand: { identity: null, tileOrder: [], selectedTileId: null },
  autoSortHand: false,
  roomSwitchIntent: null,
  retiredRoomIds: [],
  retiredRoomRevisions: {},
  departure: null,
  terminalRoomIds: [],
  roomUnavailableVersion: 0,
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
  const actionKind = choice.kind === 'pass'
    || choice.kind === 'chow'
    || choice.kind === 'pong'
    || choice.kind === 'open-kang'
    || (choice.kind === 'win' && choice.source === 'discard')
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
  | { readonly type: 'departure-redirected' }
  | { readonly type: 'select-tile'; readonly tileId: TileId | null }
  | { readonly type: 'set-tile-order'; readonly tileIds: readonly TileId[] }
  | { readonly type: 'toggle-hand-sort' }

function handIdentity(snapshot: RoomSnapshot): string | null {
  if (snapshot.stage !== 'playing' || !snapshot.privateState || !snapshot.self.canControl) return null
  return `${snapshot.roomId}:${snapshot.handId}:${snapshot.privateState.seat}`
}

function reconcileLocalHand(current: LocalHandState, snapshot: RoomSnapshot, autoSortHand: boolean): LocalHandState {
  const identity = handIdentity(snapshot)
  if (!identity || snapshot.stage !== 'playing' || !snapshot.privateState) {
    return { identity: null, tileOrder: [], selectedTileId: null }
  }
  const tileIds = snapshot.privateState.concealedTiles.map((tile) => tile.tileId)
  const available = new Set(tileIds)
  const legalDiscardIds = new Set(snapshot.privateState.legalChoices.flatMap((choice) => (
    choice.kind === 'discard' ? [choice.tileId] : []
  )))
  const tileOrder = autoSortHand
    ? sortedTileIds(snapshot.privateState.concealedTiles)
    : current.identity === identity
    ? [...current.tileOrder.filter((tileId) => available.has(tileId)), ...tileIds.filter((tileId) => !current.tileOrder.includes(tileId))]
    : tileIds
  return {
    identity,
    tileOrder,
    selectedTileId: current.identity === identity
      && current.selectedTileId
      && available.has(current.selectedTileId)
      && legalDiscardIds.has(current.selectedTileId)
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
  retiredRoomRevisions: Readonly<Record<string, number>> = {},
): boolean {
  if (
    retiredRoomIds.includes(incoming.roomId)
    && intent?.roomCode === incoming.roomCode
    && incoming.roomRevision <= (retiredRoomRevisions[incoming.roomId] ?? -1)
  ) return false
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
  if (state.terminalRoomIds.includes(snapshot.roomId) || (state.roomError && !state.roomSwitchIntent)) return state
  if (!isNewerSnapshot(
    state.roomSnapshot,
    snapshot,
    state.roomSwitchIntent,
    state.retiredRoomIds,
    state.retiredRoomRevisions,
  )) return state
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
    departure: state.departure?.status === 'uncertain' && state.departure.roomId === snapshot.roomId
      ? null
      : state.departure,
    localHand: reconcileLocalHand(
      state.roomSnapshot?.stage === 'playing' && snapshot.stage === 'playing'
        && state.roomSnapshot.phase.phaseId !== snapshot.phase.phaseId
        ? { ...state.localHand, selectedTileId: null }
        : state.localHand,
      snapshot, state.autoSortHand,
    ),
  }
}

function withoutPending(state: RealtimeState, commandId: CommandId) {
  const pendingCommands = { ...state.pendingCommands }
  delete pendingCommands[commandId]
  return pendingCommands
}

function markRoomUnavailable(state: RealtimeState, event: RoomUnavailable): RealtimeState {
  const roomId = state.roomSnapshot?.roomId
  return {
    ...state,
    roomSnapshot: null,
    roomError: event,
    roomSwitchIntent: null,
    retiredRoomIds: roomId && !state.retiredRoomIds.includes(roomId)
      ? [...state.retiredRoomIds, roomId]
      : state.retiredRoomIds,
    terminalRoomIds: roomId && !state.terminalRoomIds.includes(roomId)
      ? [...state.terminalRoomIds, roomId]
      : state.terminalRoomIds,
    roomUnavailableVersion: state.roomUnavailableVersion + 1,
    departure: null,
    localHand: INITIAL_REALTIME_STATE.localHand,
    isResynchronizing: false,
  }
}

function terminalRoomError(error: CommandError): RoomUnavailable | null {
  return error.code === 'room-expired' || error.code === 'room-not-found'
    ? { code: error.code, message: error.message }
    : null
}

export function realtimeReducer(state: RealtimeState, action: RealtimeAction): RealtimeState {
  switch (action.type) {
    case 'connecting':
      return {
        ...state,
        connectionStatus: 'connecting',
        sessionStatus: action.restoring ? 'restoring' : 'anonymous',
        isResynchronizing: action.resynchronizing ?? state.isResynchronizing,
        hasReceivedLobby: false,
        localHand: { ...state.localHand, selectedTileId: null },
      }
    case 'connected':
      return {
        ...state,
        connectionStatus: 'connected',
        sessionStatus: action.restoring ? 'restoring' : state.sessionId ? 'ready' : 'anonymous',
        localHand: action.restoring ? { ...state.localHand, selectedTileId: null } : state.localHand,
      }
    case 'disconnected':
      if (state.connectionStatus === 'superseded') return state
      return {
        ...state,
        connectionStatus: 'disconnected',
        localHand: { ...state.localHand, selectedTileId: null },
        ...(action.issue ? { lastIssue: action.issue } : {}),
      }
    case 'anonymous':
      return {
        ...INITIAL_REALTIME_STATE,
        autoSortHand: state.autoSortHand,
        connectionStatus: state.connectionStatus,
        retiredRoomIds: state.roomSnapshot
          ? [...state.retiredRoomIds, state.roomSnapshot.roomId]
          : state.retiredRoomIds,
      }
    case 'session-ready': {
      const restoredSession = action.resumed && state.sessionStatus === 'restoring'
      const resetRoom = restoredSession || !action.resumed || Boolean(action.roomError)
      const next: RealtimeState = {
        ...state,
        connectionStatus: 'connected',
        sessionStatus: 'ready',
        sessionId: action.sessionId,
        resumed: action.resumed,
        roomError: action.roomError ?? null,
        ...(resetRoom ? {
          roomSnapshot: null,
        } : {}),
        localHand: !action.resumed || action.roomError
          ? INITIAL_REALTIME_STATE.localHand
          : { ...state.localHand, selectedTileId: null },
      }
      return action.roomError
        ? markRoomUnavailable({ ...next, roomSnapshot: state.roomSnapshot }, action.roomError)
        : next
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
    case 'lobby-updated': {
      if (state.departure?.status !== 'uncertain') {
        return {
          ...state,
          lobbyRooms: action.rooms,
          hasReceivedLobby: true,
          isResynchronizing: false,
          localHand: state.sessionStatus === 'ready' && !state.roomSnapshot
            ? INITIAL_REALTIME_STATE.localHand
            : state.localHand,
        }
      }
      const departed = state.departure
      return {
        ...state,
        lobbyRooms: action.rooms,
        hasReceivedLobby: true,
        isResynchronizing: false,
        roomSnapshot: null,
        localHand: INITIAL_REALTIME_STATE.localHand,
        retiredRoomIds: state.retiredRoomIds.includes(departed.roomId)
          ? state.retiredRoomIds
          : [...state.retiredRoomIds, departed.roomId],
        retiredRoomRevisions: {
          ...state.retiredRoomRevisions,
          [departed.roomId]: departed.roomRevision,
        },
        departure: { ...departed, status: 'detached' },
      }
    }
    case 'snapshot-received':
      return receiveSnapshot(state, action.snapshot)
    case 'room-unavailable':
      return markRoomUnavailable(state, action.event)
    case 'command-pending':
      return {
        ...state,
        pendingCommands: { ...state.pendingCommands, [action.pending.commandId]: action.pending },
        roomSwitchIntent: action.roomSwitchIntent ?? state.roomSwitchIntent,
        departure: action.pending.type === 'room.leave'
          && action.pending.roomId !== undefined
          && state.roomSnapshot?.roomId === action.pending.roomId
          ? {
            roomId: action.pending.roomId,
            roomCode: state.roomSnapshot.roomCode,
            roomRevision: state.roomSnapshot.roomRevision,
            status: 'pending',
          }
          : state.departure,
        lastIssue: null,
      }
    case 'command-finished': {
      let next = { ...state, pendingCommands: withoutPending(state, action.command.commandId) }
      const pending = state.pendingCommands[action.command.commandId]
      if (pending?.roomUnavailableVersion !== undefined
        && pending.roomUnavailableVersion < state.roomUnavailableVersion) return next
      if (action.acknowledgement.status === 'rejected') {
        next = {
          ...next,
          lastIssue: { kind: 'server', commandId: action.acknowledgement.commandId, error: action.acknowledgement.error },
          roomSwitchIntent: null,
          departure: action.command.type === 'room.leave' ? null : next.departure,
        }
        const terminal = (
          action.command.type === 'room.inspect'
          || action.command.type === 'room.join'
          || action.command.type === 'room.takeover'
          || action.command.type === 'room.spectate'
        ) ? terminalRoomError(action.acknowledgement.error) : null
        if (terminal) return markRoomUnavailable(next, terminal)
        if (action.acknowledgement.snapshot) next = receiveSnapshot(next, action.acknowledgement.snapshot)
        return next
      }
      const result = action.acknowledgement.result
      if (result.kind === 'lobby-rooms') next = { ...next, lobbyRooms: result.rooms, isResynchronizing: false }
      if (result.kind === 'room-snapshot') next = receiveSnapshot(next, result.snapshot)
      if (action.command.type === 'room.leave') {
        if (result.kind !== 'room-departure') return next
        if (result.disposition === 'reserved') {
          return {
            ...next,
            departure: null,
            lastIssue: {
              kind: 'transport',
              code: 'room-seat-reserved',
              message: 'The hand began before you left. Your seat remains reserved; switching tables is available between hands.',
            },
          }
        }
        const roomCode = state.departure?.roomCode ?? state.roomSnapshot?.roomCode
        next = {
          ...next,
          roomSnapshot: null,
          roomSwitchIntent: null,
          retiredRoomIds: state.retiredRoomIds.includes(action.command.roomId)
            ? state.retiredRoomIds
            : [...state.retiredRoomIds, action.command.roomId],
          retiredRoomRevisions: {
            ...state.retiredRoomRevisions,
            [action.command.roomId]: result.roomRevision,
          },
          localHand: INITIAL_REALTIME_STATE.localHand,
          departure: roomCode ? {
            roomId: action.command.roomId,
            roomCode,
            roomRevision: result.roomRevision,
            status: 'detached',
          } : null,
        }
      }
      return next
    }
    case 'command-abandoned': {
      const abandoned = state.pendingCommands[action.commandId]
      return {
        ...state,
        pendingCommands: withoutPending(state, action.commandId),
        lastIssue: action.issue,
        departure: abandoned?.type === 'room.leave' && state.departure?.status === 'pending'
          ? { ...state.departure, status: 'uncertain' }
          : state.departure,
      }
    }
    case 'issue':
      return { ...state, lastIssue: action.issue }
    case 'clear-issue':
      return { ...state, lastIssue: null, roomError: null }
    case 'resynchronizing':
      return { ...state, isResynchronizing: true }
    case 'departure-redirected':
      return { ...state, departure: null }
    case 'select-tile':
      return state.roomSnapshot?.stage === 'playing'
        && state.roomSnapshot.privateState?.legalChoices.some((choice) => (
          choice.kind === 'discard' && choice.tileId === action.tileId
        ))
        ? { ...state, localHand: { ...state.localHand, selectedTileId: action.tileId } }
        : action.tileId === null
          ? { ...state, localHand: { ...state.localHand, selectedTileId: null } }
          : state
    case 'set-tile-order': {
      const existing = new Set(state.localHand.tileOrder)
      if (
        action.tileIds.length !== existing.size
        || new Set(action.tileIds).size !== existing.size
        || action.tileIds.some((tileId) => !existing.has(tileId))
      ) return state
      if (action.tileIds.every((tileId, index) => tileId === state.localHand.tileOrder[index])) return state
      return { ...state, autoSortHand: false, localHand: { ...state.localHand, tileOrder: [...action.tileIds] } }
    }
    case 'toggle-hand-sort': {
      if (state.autoSortHand) return { ...state, autoSortHand: false }
      const snapshot = state.roomSnapshot
      if (snapshot?.stage !== 'playing' || !snapshot.privateState) return state
      return {
        ...state,
        autoSortHand: true,
        localHand: { ...state.localHand, tileOrder: sortedTileIds(snapshot.privateState.concealedTiles) },
      }
    }
  }
}
