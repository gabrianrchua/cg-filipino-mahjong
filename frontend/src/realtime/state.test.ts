import {
  ACTIVE_LOCAL_TURN_FIXTURE,
  COMPLETED_HAND_FIXTURE,
  WAITING_ROOM_FIXTURE,
  type ActiveGameSnapshot,
  type ClientCommand,
  type CommandAcknowledgement,
  type RoomSnapshot,
} from '@cg-filipino-mahjong/shared'
import { describe, expect, it, vi } from 'vitest'

import { attachRealtimeListeners } from './RealtimeProvider.tsx'
import {
  INITIAL_REALTIME_STATE,
  gameplayCommandForChoice,
  isNewerSnapshot,
  realtimeReducer,
  type RealtimeState,
} from './state.ts'

const id = (suffix: number) => `10000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
const ACTIVE_FIXTURE = ACTIVE_LOCAL_TURN_FIXTURE as ActiveGameSnapshot

function activeSnapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return { ...ACTIVE_LOCAL_TURN_FIXTURE, ...overrides } as RoomSnapshot
}

function withSnapshot(snapshot: RoomSnapshot): RealtimeState {
  return realtimeReducer(INITIAL_REALTIME_STATE, { type: 'snapshot-received', snapshot })
}

describe('authoritative snapshot ordering', () => {
  it('tracks whether the initial live lobby payload has arrived and resets it on reconnect', () => {
    const received = realtimeReducer(INITIAL_REALTIME_STATE, { type: 'lobby-updated', rooms: [] })
    expect(received.hasReceivedLobby).toBe(true)
    expect(realtimeReducer(received, { type: 'connecting', restoring: true }).hasReceivedLobby).toBe(false)
  })

  it('drops stale room and private-hand state before accepting a restored session snapshot', () => {
    const disconnected = realtimeReducer({
      ...withSnapshot(ACTIVE_LOCAL_TURN_FIXTURE),
      connectionStatus: 'disconnected',
      sessionStatus: 'ready',
    }, { type: 'connecting', restoring: true, resynchronizing: true })
    const restored = realtimeReducer(disconnected, {
      type: 'session-ready', sessionId: id(30), resumed: true,
    })

    expect(restored.roomSnapshot).toBeNull()
    expect(restored.localHand).toEqual({ identity: null, tileOrder: [], selectedTileId: null })
    expect(restored.isResynchronizing).toBe(true)

    const refreshed = realtimeReducer(restored, {
      type: 'snapshot-received', snapshot: ACTIVE_LOCAL_TURN_FIXTURE,
    })
    expect(refreshed.roomSnapshot).toBe(ACTIVE_LOCAL_TURN_FIXTURE)
    expect(refreshed.isResynchronizing).toBe(false)
  })

  it('ignores lower room and game revisions for the same room and hand', () => {
    const current = activeSnapshot({ roomRevision: 8, gameRevision: 20 })
    expect(isNewerSnapshot(current, activeSnapshot({ roomRevision: 7, gameRevision: 21 }), null, [])).toBe(false)
    expect(isNewerSnapshot(current, activeSnapshot({ roomRevision: 9, gameRevision: 19 }), null, [])).toBe(false)
    expect(isNewerSnapshot(current, activeSnapshot({ roomRevision: 9, gameRevision: 21 }), null, [])).toBe(true)
  })

  it('accepts an intended room switch and rejects a delayed snapshot from the retired room', () => {
    const original = withSnapshot(WAITING_ROOM_FIXTURE)
    const command = {
      commandId: id(1),
      type: 'room.join',
      roomCode: 'ABC234',
    } satisfies ClientCommand
    const pending = realtimeReducer(original, {
      type: 'command-pending',
      pending: { commandId: command.commandId, type: command.type, startedAt: 1 },
      roomSwitchIntent: { roomCode: command.roomCode },
    })
    const switchedSnapshot = {
      ...WAITING_ROOM_FIXTURE,
      roomId: id(2),
      roomCode: 'ABC234',
      roomRevision: 1,
    } as RoomSnapshot
    const switched = realtimeReducer(pending, { type: 'snapshot-received', snapshot: switchedSnapshot })
    expect(switched.roomSnapshot?.roomId).toBe(id(2))
    expect(switched.retiredRoomIds).toContain(WAITING_ROOM_FIXTURE.roomId)

    const delayed = realtimeReducer(switched, { type: 'snapshot-received', snapshot: WAITING_ROOM_FIXTURE })
    expect(delayed.roomSnapshot?.roomId).toBe(id(2))
  })

  it('routes stale-error snapshots through the same freshness rules', () => {
    const current = withSnapshot(activeSnapshot({ roomRevision: 10, gameRevision: 25 }))
    const command = {
      commandId: id(3), type: 'game.action', roomId: ACTIVE_LOCAL_TURN_FIXTURE.roomId,
      handId: ACTIVE_FIXTURE.handId,
      phaseId: ACTIVE_FIXTURE.phase.phaseId,
      action: { kind: 'discard', choiceId: id(4) },
    } satisfies ClientCommand
    const acknowledgement = {
      commandId: command.commandId,
      status: 'rejected',
      duplicate: false,
      error: { code: 'stale-phase', message: 'The phase changed.' },
      snapshot: activeSnapshot({ roomRevision: 9, gameRevision: 24 }),
    } satisfies CommandAcknowledgement
    const next = realtimeReducer(current, { type: 'command-finished', command, acknowledgement })
    expect(next.roomSnapshot).toBe(current.roomSnapshot)
    expect(next.lastIssue).toMatchObject({ kind: 'server', error: { code: 'stale-phase' } })
  })
})

describe('room departure', () => {
  const leave = {
    commandId: id(40), type: 'room.leave', roomId: WAITING_ROOM_FIXTURE.roomId,
  } satisfies ClientCommand

  function pendingLeave(): RealtimeState {
    return realtimeReducer(withSnapshot(WAITING_ROOM_FIXTURE), {
      type: 'command-pending',
      pending: { commandId: leave.commandId, type: leave.type, roomId: leave.roomId, startedAt: 1 },
    })
  }

  it('clears only a confirmed detached room and ignores its delayed snapshots', () => {
    const pending = pendingLeave()
    expect(pending.roomSnapshot).toBe(WAITING_ROOM_FIXTURE)
    const left = realtimeReducer(pending, {
      type: 'command-finished', command: leave,
      acknowledgement: {
        commandId: leave.commandId, status: 'accepted', duplicate: false,
        result: { kind: 'room-departure', disposition: 'detached', roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 1 },
      },
    })
    expect(left.roomSnapshot).toBeNull()
    expect(left.departure).toMatchObject({ roomCode: WAITING_ROOM_FIXTURE.roomCode, status: 'detached' })
    expect(left.retiredRoomIds).toContain(leave.roomId)
    expect(realtimeReducer(left, { type: 'snapshot-received', snapshot: WAITING_ROOM_FIXTURE }).roomSnapshot).toBeNull()

    const lobby = realtimeReducer(left, { type: 'departure-redirected' })
    const rejoin = realtimeReducer(lobby, {
      type: 'command-pending',
      pending: { commandId: id(41), type: 'room.join', startedAt: 2 },
      roomSwitchIntent: { roomCode: WAITING_ROOM_FIXTURE.roomCode },
    })
    expect(realtimeReducer(rejoin, { type: 'snapshot-received', snapshot: WAITING_ROOM_FIXTURE }).roomSnapshot)
      .toBeNull()
    const preLeavePublication = { ...WAITING_ROOM_FIXTURE, roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 1 }
    expect(realtimeReducer(rejoin, { type: 'snapshot-received', snapshot: preLeavePublication }).roomSnapshot)
      .toBeNull()
    const rejoinedSnapshot = { ...WAITING_ROOM_FIXTURE, roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 2 }
    expect(realtimeReducer(rejoin, { type: 'snapshot-received', snapshot: rejoinedSnapshot }).roomSnapshot)
      .toEqual(rejoinedSnapshot)
  })

  it('keeps a seat reserved when a hand starts before the leave is processed', () => {
    const reserved = realtimeReducer(pendingLeave(), {
      type: 'command-finished', command: leave,
      acknowledgement: {
        commandId: leave.commandId, status: 'accepted', duplicate: false,
        result: { kind: 'room-departure', disposition: 'reserved', roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 1 },
      },
    })
    expect(reserved.roomSnapshot).toBe(WAITING_ROOM_FIXTURE)
    expect(reserved.departure).toBeNull()
    expect(reserved.lastIssue).toMatchObject({ code: 'room-seat-reserved' })
  })

  it('reconciles an uncertain leave from a restored lobby or room snapshot', () => {
    const uncertain = realtimeReducer(pendingLeave(), {
      type: 'command-abandoned', commandId: leave.commandId,
      issue: { kind: 'transport', code: 'acknowledgement-timeout', message: 'Timed out' },
    })
    expect(uncertain.roomSnapshot).toBe(WAITING_ROOM_FIXTURE)
    expect(uncertain.departure?.status).toBe('uncertain')

    const restoring = realtimeReducer(uncertain, { type: 'connecting', restoring: true, resynchronizing: true })
    const restored = realtimeReducer(restoring, { type: 'session-ready', sessionId: id(42), resumed: true })
    const detached = realtimeReducer(restored, { type: 'lobby-updated', rooms: [] })
    expect(detached.departure?.status).toBe('detached')
    expect(detached.roomSnapshot).toBeNull()
    expect(detached.retiredRoomIds).toContain(leave.roomId)

    const stillSeated = realtimeReducer(restored, { type: 'snapshot-received', snapshot: WAITING_ROOM_FIXTURE })
    expect(stillSeated.roomSnapshot).toBe(WAITING_ROOM_FIXTURE)
    expect(stillSeated.departure).toBeNull()
  })
})

describe('local hand state', () => {
  it('keeps order and selection outside snapshots, appends draws, and removes missing tiles', () => {
    let state = withSnapshot(ACTIVE_LOCAL_TURN_FIXTURE)
    const originalTiles = [...state.localHand.tileOrder]
    state = realtimeReducer(state, { type: 'set-tile-order', tileIds: [...originalTiles].reverse() })
    state = realtimeReducer(state, { type: 'select-tile', tileId: originalTiles[0]! })

    const privateState = ACTIVE_FIXTURE.privateState!
    const nextSnapshot = activeSnapshot({
      roomRevision: ACTIVE_LOCAL_TURN_FIXTURE.roomRevision + 1,
      gameRevision: ACTIVE_FIXTURE.gameRevision + 1,
      privateState: {
        ...privateState,
        concealedTiles: [privateState.concealedTiles[1]!, privateState.concealedTiles[2]!, {
          tileId: 'balls-9-new', kind: 'suited', suit: 'balls', rank: 9,
        }],
      },
    })
    state = realtimeReducer(state, { type: 'snapshot-received', snapshot: nextSnapshot })

    expect(state.localHand.tileOrder).toEqual([
      privateState.concealedTiles[2]!.tileId,
      privateState.concealedTiles[1]!.tileId,
      'balls-9-new',
    ])
    expect(state.localHand.selectedTileId).toBeNull()
    expect(ACTIVE_FIXTURE.privateState?.concealedTiles.map((tile) => tile.tileId)).toEqual(originalTiles)
  })

  it('resets arrangement when a room becomes unavailable', () => {
    const state = realtimeReducer(withSnapshot(ACTIVE_LOCAL_TURN_FIXTURE), {
      type: 'room-unavailable',
      event: { code: 'room-expired', message: 'The room expired.' },
    })
    expect(state.roomSnapshot).toBeNull()
    expect(state.localHand).toEqual({ identity: null, tileOrder: [], selectedTileId: null })
  })

  it('discards local hand state between hands and starts the next hand with a fresh identity', () => {
    let state = withSnapshot(ACTIVE_LOCAL_TURN_FIXTURE)
    const initialIds = [...state.localHand.tileOrder]
    state = realtimeReducer(state, { type: 'set-tile-order', tileIds: [...initialIds].reverse() })
    state = realtimeReducer(state, { type: 'select-tile', tileId: initialIds[0]! })

    state = realtimeReducer(state, { type: 'snapshot-received', snapshot: COMPLETED_HAND_FIXTURE })
    expect(state.localHand).toEqual({ identity: null, tileOrder: [], selectedTileId: null })

    const nextHand = activeSnapshot({
      roomRevision: COMPLETED_HAND_FIXTURE.roomRevision + 1,
      handId: id(31),
      gameRevision: 0,
    })
    state = realtimeReducer(state, { type: 'snapshot-received', snapshot: nextHand })

    expect(state.localHand.identity).toBe(`${nextHand.roomId}:${id(31)}:0`)
    expect(state.localHand.tileOrder).toEqual(ACTIVE_FIXTURE.privateState!.concealedTiles.map((tile) => tile.tileId))
    expect(state.localHand.selectedTileId).toBeNull()
  })

  it('clears selection when the server no longer offers that tile as a discard', () => {
    let state = withSnapshot(ACTIVE_LOCAL_TURN_FIXTURE)
    const selected = ACTIVE_FIXTURE.privateState!.legalChoices[0]!
    if (selected.kind !== 'discard') throw new Error('Expected a discard fixture')
    state = realtimeReducer(state, { type: 'select-tile', tileId: selected.tileId })
    expect(state.localHand.selectedTileId).toBe(selected.tileId)

    const nextSnapshot = activeSnapshot({
      roomRevision: ACTIVE_LOCAL_TURN_FIXTURE.roomRevision + 1,
      gameRevision: ACTIVE_FIXTURE.gameRevision + 1,
      privateState: { ...ACTIVE_FIXTURE.privateState!, legalChoices: [] },
    })
    state = realtimeReducer(state, { type: 'snapshot-received', snapshot: nextSnapshot })
    expect(state.localHand.selectedTileId).toBeNull()
  })

  it('rejects reorder payloads with duplicated physical IDs', () => {
    const state = withSnapshot(ACTIVE_LOCAL_TURN_FIXTURE)
    const duplicate = [state.localHand.tileOrder[0]!, state.localHand.tileOrder[0]!, state.localHand.tileOrder[2]!]
    expect(realtimeReducer(state, { type: 'set-tile-order', tileIds: duplicate })).toBe(state)
  })
})

describe('gameplay command gating', () => {
  const choiceId = ACTIVE_FIXTURE.privateState!.legalChoices[0]!.choiceId

  function playableState(): RealtimeState {
    return {
      ...withSnapshot(ACTIVE_FIXTURE),
      connectionStatus: 'connected',
      sessionStatus: 'ready',
      sessionId: id(20),
    }
  }

  it('constructs a phase-scoped command only from a currently offered choice', () => {
    expect(gameplayCommandForChoice(playableState(), choiceId)).toEqual({
      ok: true,
      command: {
        type: 'game.action',
        roomId: ACTIVE_FIXTURE.roomId,
        handId: ACTIVE_FIXTURE.handId,
        phaseId: ACTIVE_FIXTURE.phase.phaseId,
        action: { kind: 'discard', choiceId },
      },
    })
    expect(gameplayCommandForChoice(playableState(), id(99))).toMatchObject({
      ok: false, issue: { code: 'choice-not-legal' },
    })
  })

  it('submits a discard win through the discard-response action path', () => {
    const discardWinChoice = { choiceId: id(98), kind: 'win' as const, source: 'discard' as const }
    const responseSnapshot = {
      ...ACTIVE_FIXTURE,
      phase: {
        phaseId: id(97), kind: 'discard-responses' as const, discarderSeat: 1 as const,
        latestDiscard: { tileId: 'discard-win-tile', kind: 'suited' as const, suit: 'balls' as const, rank: 9 as const },
        respondedSeats: [],
      },
      privateState: { ...ACTIVE_FIXTURE.privateState!, legalChoices: [discardWinChoice] },
    }
    const state = {
      ...playableState(),
      roomSnapshot: responseSnapshot,
    } satisfies RealtimeState

    expect(gameplayCommandForChoice(state, discardWinChoice.choiceId)).toMatchObject({
      ok: true,
      command: { action: { kind: 'respond-to-discard', choiceId: discardWinChoice.choiceId } },
    })
  })

  it('blocks gameplay while paused, disconnected, resynchronizing, or already pending', () => {
    const playable = playableState()
    const paused = {
      ...playable,
      roomSnapshot: { ...ACTIVE_FIXTURE, pause: { isPaused: true, disconnectedSeats: [1] } },
    } satisfies RealtimeState
    expect(gameplayCommandForChoice(paused, choiceId)).toMatchObject({ ok: false, issue: { code: 'gameplay-blocked' } })
    expect(gameplayCommandForChoice({ ...playable, connectionStatus: 'disconnected' }, choiceId))
      .toMatchObject({ ok: false, issue: { code: 'gameplay-blocked' } })
    expect(gameplayCommandForChoice({ ...playable, isResynchronizing: true }, choiceId))
      .toMatchObject({ ok: false, issue: { code: 'gameplay-blocked' } })
    const pending = {
      ...playable,
      pendingCommands: {
        [id(21)]: {
          commandId: id(21), type: 'game.action', startedAt: 1,
          roomId: ACTIVE_FIXTURE.roomId, handId: ACTIVE_FIXTURE.handId, phaseId: ACTIVE_FIXTURE.phase.phaseId,
        },
      },
    } satisfies RealtimeState
    expect(gameplayCommandForChoice(pending, choiceId)).toMatchObject({ ok: false, issue: { code: 'gameplay-pending' } })
  })
})

describe('socket listener lifecycle', () => {
  it('removes the exact listeners it registered', () => {
    const on = vi.fn()
    const off = vi.fn()
    const socket = { on, off }
    const handlers = {
      connect: vi.fn(), disconnect: vi.fn(), connectError: vi.fn(), sessionReady: vi.fn(),
      lobbyUpdated: vi.fn(), roomSnapshot: vi.fn(), roomUnavailable: vi.fn(), sessionSuperseded: vi.fn(),
    }
    const detach = attachRealtimeListeners(socket as never, handlers)
    expect(on).toHaveBeenCalledTimes(8)
    detach()
    expect(off).toHaveBeenCalledTimes(8)
    for (let index = 0; index < on.mock.calls.length; index += 1) {
      expect(off.mock.calls[index]).toEqual(on.mock.calls[index])
    }
  })
})
