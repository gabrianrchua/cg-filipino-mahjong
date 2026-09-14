import {
  CommandAcknowledgementSchema,
  WAITING_ROOM_FIXTURE,
  type CommandAcknowledgement,
} from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import { initializeHand } from '../game-engine/index.js'
import { RoomService } from '../room-service/index.js'
import { RealtimeCoordinator } from './coordinator.js'

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

function acceptedControl(acknowledgement: CommandAcknowledgement) {
  expect(acknowledgement.status).toBe('accepted')
}

describe('realtime coordinator', () => {
  it('validates malformed payloads and represents missing command IDs as null', async () => {
    const coordinator = new RealtimeCoordinator()
    const result = await coordinator.handleCommand('socket-a', undefined, { type: 'lobby.list' })
    expect(CommandAcknowledgementSchema.safeParse(result.acknowledgement).success).toBe(true)
    expect(result.acknowledgement).toMatchObject({
      commandId: null,
      status: 'rejected',
      error: { code: 'validation-error' },
    })
  })

  it('replays exact commands, rejects conflicting reuse, and does not reapply mutations', async () => {
    const coordinator = new RealtimeCoordinator()
    const bootstrap = { commandId: id(1), type: 'session.bootstrap', displayName: 'Ana' } as const
    const first = await coordinator.handleCommand('socket-a', undefined, bootstrap)
    acceptedControl(first.acknowledgement)
    if (!first.control) throw new Error('Expected session control')

    const duplicate = await coordinator.handleCommand('socket-a', first.control, bootstrap)
    expect(duplicate.acknowledgement).toMatchObject({ status: 'accepted', duplicate: true })

    const conflict = await coordinator.handleCommand('socket-a', first.control, {
      ...bootstrap,
      displayName: 'Someone Else',
    })
    expect(conflict.acknowledgement).toMatchObject({
      status: 'rejected',
      duplicate: true,
      error: { code: 'command-conflict' },
    })

    const create = { commandId: id(2), type: 'room.create', visibility: 'public' } as const
    const created = await coordinator.handleCommand('socket-a', first.control, create)
    expect(created.acknowledgement.status).toBe('accepted')
    const retried = await coordinator.handleCommand('socket-a', first.control, create)
    expect(retried.acknowledgement).toMatchObject({ status: 'accepted', duplicate: true })
    const rooms = coordinator.roomService.listPublicRooms(first.control)
    expect(rooms.ok && rooms.value.rooms).toHaveLength(1)
  })

  it('rejects takeover commands for unknown rooms', async () => {
    const coordinator = new RealtimeCoordinator()
    const bootstrap = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(10), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (!bootstrap.control) throw new Error('Expected session control')
    const future = await coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(11), type: 'room.takeover', roomCode: 'ABC234', seat: 1,
    })
    expect(future.acknowledgement).toMatchObject({
      status: 'rejected',
      error: { code: 'room-not-found' },
    })
  })

  it('attaches a recipient snapshot to stale errors through the view port', async () => {
    let snapshotRequests = 0
    const coordinator = new RealtimeCoordinator({
      viewPort: {
        snapshotFor: () => {
          snapshotRequests += 1
          return WAITING_ROOM_FIXTURE
        },
        roomChanged: () => undefined,
        lobbyChanged: () => undefined,
      },
    })
    const bootstrap = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(20), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (!bootstrap.control) throw new Error('Expected session control')
    const created = await coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(21), type: 'room.create', visibility: 'public',
    })
    if (!created.room) throw new Error('Expected a room')
    const stale = await coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(22),
      type: 'room.set-visibility',
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.roomRevision + 1,
      visibility: 'unlisted',
    })
    expect(stale.acknowledgement).toMatchObject({
      status: 'rejected',
      error: { code: 'stale-room' },
      snapshot: WAITING_ROOM_FIXTURE,
    })
    expect(snapshotRequests).toBe(1)
  })

  it('serializes competing takeovers and commits exactly one guest', async () => {
    const roomService = new RoomService()
    const ana = roomService.bootstrapSession('Ana', 'socket-a')
    const ben = roomService.bootstrapSession('Ben', 'socket-b')
    const cora = roomService.bootstrapSession('Cora', 'socket-c')
    if (!ana.ok || !ben.ok || !cora.ok) throw new Error('Expected sessions')
    let room = roomService.createRoom(ana.value.control, 'public')
    if (!room.ok) throw new Error('Expected room')
    const configured = roomService.configureSeat(
      ana.value.control,
      room.value.roomId,
      room.value.roomRevision,
      1,
      'bot',
    )
    if (!configured.ok) throw new Error('Expected bot seat')
    room = configured
    const coordinator = new RealtimeCoordinator({ roomService })
    const attempts = await Promise.all([
      coordinator.handleCommand('socket-b', ben.value.control, {
        commandId: id(31), type: 'room.takeover', roomCode: room.value.roomCode, seat: 1,
      }),
      coordinator.handleCommand('socket-c', cora.value.control, {
        commandId: id(32), type: 'room.takeover', roomCode: room.value.roomCode, seat: 1,
      }),
    ])
    expect(attempts.map((attempt) => attempt.acknowledgement.status).sort())
      .toEqual(['accepted', 'rejected'])
    expect(attempts.find((attempt) => attempt.acknowledgement.status === 'rejected')?.acknowledgement)
      .toMatchObject({ error: { code: 'seat-unavailable' } })
  })

  it('commits only one simultaneous proposal and serializes reconnect against final approval', async () => {
    const roomService = new RoomService()
    const ana = roomService.bootstrapSession('Ana', 'socket-a')
    const ben = roomService.bootstrapSession('Ben', 'socket-b')
    const cora = roomService.bootstrapSession('Cora', 'socket-c')
    if (!ana.ok || !ben.ok || !cora.ok) throw new Error('Expected sessions')
    let created = roomService.createRoom(ana.value.control, 'public')
    if (!created.ok) throw new Error('Expected a room')
    let room = created.value
    const joinedBen = roomService.joinRoom(ben.value.control, room.roomCode)
    if (!joinedBen.ok) throw new Error('Expected Ben to join')
    room = joinedBen.value
    const joinedCora = roomService.joinRoom(cora.value.control, room.roomCode)
    if (!joinedCora.ok) throw new Error('Expected Cora to join')
    room = joinedCora.value
    const configured = roomService.configureSeat(ana.value.control, room.roomId, room.roomRevision, 3, 'bot')
    if (!configured.ok) throw new Error('Expected a bot seat')
    room = configured.value
    const disconnected = roomService.disconnect(cora.value.control)
    if (!disconnected.ok || !disconnected.value.room) throw new Error('Expected Cora to disconnect')

    const coordinator = new RealtimeCoordinator({ roomService })
    const proposals = await Promise.all([
      coordinator.handleCommand('socket-a', ana.value.control, {
        commandId: id(40), type: 'proposal.create', roomId: room.roomId,
        proposal: { kind: 'replace-with-bot', targetSeat: 2 },
      }),
      coordinator.handleCommand('socket-b', ben.value.control, {
        commandId: id(41), type: 'proposal.create', roomId: room.roomId,
        proposal: { kind: 'replace-with-bot', targetSeat: 2 },
      }),
    ])
    expect(proposals.map((result) => result.acknowledgement.status).sort()).toEqual(['accepted', 'rejected'])
    expect(proposals.find((result) => result.acknowledgement.status === 'rejected')?.acknowledgement)
      .toMatchObject({ error: { code: 'proposal-active' } })

    const active = roomService.getRoom(ana.value.control, room.roomId)
    if (!active.ok || !active.value.proposal) throw new Error('Expected one proposal')
    const proposalId = active.value.proposal.proposalId
    const pendingVoter = active.value.proposal.proposedBy === 0 ? ben.value : ana.value
    const [vote, reconnect] = await Promise.all([
      coordinator.handleCommand(pendingVoter.control.controllerId, pendingVoter.control, {
        commandId: id(42), type: 'proposal.vote', roomId: room.roomId, proposalId, vote: 'approve',
      }),
      coordinator.authenticate(cora.value.reconnectCredential, 'socket-c-returned'),
    ])
    if (vote.acknowledgement.status === 'accepted') {
      expect(reconnect.ok && reconnect.value.room).toBeNull()
      const finalRoom = roomService.getRoom(ana.value.control, room.roomId)
      expect(finalRoom.ok && finalRoom.value.seats[2].controller.kind).toBe('bot')
    } else {
      expect(vote.acknowledgement).toMatchObject({ error: { code: 'proposal-not-found' } })
      expect(reconnect.ok && reconnect.value.room?.seats[2].controller)
        .toMatchObject({ kind: 'human', connected: true })
    }
  })

  it('returns a private snapshot only after takeover and invalidates the old bot timer', async () => {
    interface TimerTask { callback: () => void; cancelled: boolean }
    const tasks: TimerTask[] = []
    const roomService = new RoomService({
      initializeHand: () => initializeHand({ dealerSeat: 1, randomSource: { nextInt: () => 0 } }),
    })
    const coordinator = new RealtimeCoordinator({
      roomService,
      botRandomSource: { nextInt: () => 0 },
      botTimers: {
        setTimeout: (callback) => {
          const task = { callback, cancelled: false }
          tasks.push(task)
          return task
        },
        clearTimeout: (handle) => { (handle as TimerTask).cancelled = true },
      },
    })
    const ana = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(70), type: 'session.bootstrap', displayName: 'Ana',
    })
    const ben = await coordinator.handleCommand('socket-b', undefined, {
      commandId: id(71), type: 'session.bootstrap', displayName: 'Ben',
    })
    if (!ana.control || !ben.control) throw new Error('Expected sessions')
    const created = await coordinator.handleCommand('socket-a', ana.control, {
      commandId: id(72), type: 'room.create', visibility: 'public',
    })
    if (!created.room) throw new Error('Expected room')
    let room = created.room
    for (const [commandId, seat] of [[73, 1], [74, 2], [75, 3]] as const) {
      const configured = await coordinator.handleCommand('socket-a', ana.control, {
        commandId: id(commandId), type: 'room.configure-seat', roomId: room.roomId,
        expectedRoomRevision: room.roomRevision, seat, controller: 'bot',
      })
      if (!configured.room) throw new Error('Expected configured room')
      room = configured.room
    }
    const started = await coordinator.handleCommand('socket-a', ana.control, {
      commandId: id(76), type: 'room.set-ready', roomId: room.roomId,
      readinessId: room.readinessId, ready: true,
    })
    if (!started.room || started.room.stage.kind !== 'playing') throw new Error('Expected active play')
    const originalState = started.room.stage.engineState
    const oldBotTask = tasks.find((task) => !task.cancelled)
    expect(oldBotTask).toBeDefined()

    const takeover = await coordinator.handleCommand('socket-b', ben.control, {
      commandId: id(77), type: 'room.takeover', roomCode: room.roomCode, seat: 1,
    })
    expect(takeover.acknowledgement).toMatchObject({
      status: 'accepted',
      result: {
        kind: 'room-snapshot',
        snapshot: { self: { seat: 1, canControl: true } },
      },
    })
    expect(oldBotTask?.cancelled).toBe(true)
    oldBotTask?.callback()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    const current = roomService.getControlledRoom(ben.control)
    expect(current.ok && current.value?.stage.kind === 'playing' && current.value.stage.engineState)
      .toBe(originalState)
  })

  it('schedules delayed bot actions, pauses safely, and preserves other same-phase response timers', async () => {
    interface TimerTask { callback: () => void; cancelled: boolean; delayMs: number }
    const tasks: TimerTask[] = []
    const roomService = new RoomService({
      initializeHand: () => initializeHand({ dealerSeat: 1, randomSource: { nextInt: () => 0 } }),
    })
    const coordinator = new RealtimeCoordinator({
      roomService,
      botRandomSource: { nextInt: () => 0 },
      botTimers: {
        setTimeout: (callback, delayMs) => {
          const task = { callback, delayMs, cancelled: false }
          tasks.push(task)
          return task
        },
        clearTimeout: (handle) => { (handle as TimerTask).cancelled = true },
      },
    })
    const flush = async () => {
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    const bootstrap = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(100), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (
      !bootstrap.control
      || bootstrap.acknowledgement.status !== 'accepted'
      || bootstrap.acknowledgement.result.kind !== 'session-bootstrapped'
    ) throw new Error('Expected a session')
    const credential = bootstrap.acknowledgement.result.reconnectCredential
    const created = await coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(101), type: 'room.create', visibility: 'public',
    })
    if (!created.room) throw new Error('Expected a room')
    let room = created.room
    for (const [commandId, seat] of [[102, 1], [103, 2], [104, 3]] as const) {
      const configured = await coordinator.handleCommand('socket-a', bootstrap.control, {
        commandId: id(commandId), type: 'room.configure-seat', roomId: room.roomId,
        expectedRoomRevision: room.roomRevision, seat, controller: 'bot',
      })
      if (!configured.room) throw new Error('Expected configured room')
      room = configured.room
    }
    const started = await coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(105), type: 'room.set-ready', roomId: room.roomId,
      readinessId: room.readinessId, ready: true,
    })
    if (!started.room || started.room.stage.kind !== 'playing') throw new Error('Expected bot play')
    const first = tasks.find((task) => !task.cancelled)
    expect(first?.delayMs).toBe(600)

    await coordinator.disconnect(bootstrap.control)
    expect(first?.cancelled).toBe(true)
    first?.callback()
    await flush()
    const paused = roomService.getBotDecisionSnapshot(room.roomId, 1)
    expect(paused.ok && paused.value.stage === 'playing' && paused.value.phase.kind).toBe('player-action')

    const authenticated = await coordinator.authenticate(credential, 'socket-returned')
    if (!authenticated.ok) throw new Error('Expected reconnect')
    let responding = roomService.getBotDecisionSnapshot(room.roomId, 2)
    for (let actionCount = 0; actionCount < 8; actionCount += 1) {
      if (responding.ok && responding.value.stage === 'playing' && responding.value.phase.kind === 'discard-responses') break
      const actionTask = [...tasks].reverse().find((task) => !task.cancelled)
      if (!actionTask) throw new Error('Expected a resumed bot decision')
      actionTask.cancelled = true
      actionTask.callback()
      await flush()
      responding = roomService.getBotDecisionSnapshot(room.roomId, 2)
    }

    if (!responding.ok || responding.value.stage !== 'playing') throw new Error('Expected bot responses')
    expect(responding.value.phase.kind).toBe('discard-responses')
    const responseTasks = tasks.filter((task) => !task.cancelled)
    expect(responseTasks).toHaveLength(2)
    const preserved = responseTasks[1]!
    responseTasks[0]!.callback()
    await flush()
    expect(preserved.cancelled).toBe(false)
    expect(tasks.filter((task) => !task.cancelled)).toContain(preserved)

    const expired = await coordinator.expireRoom(room.roomId)
    expect(expired.ok).toBe(true)
    expect(preserved.cancelled).toBe(true)
    preserved.callback()
    await flush()
    const missing = roomService.resolveRoomId(room.roomCode)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('room-expired')
  })
})
