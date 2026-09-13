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

  it('routes future command families through a stable typed extension point', async () => {
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
      error: { code: 'action-not-legal' },
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

  it('serializes future operations targeting the same room', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const coordinator = new RealtimeCoordinator({
      futureCommandHandler: async ({ command }) => {
        order.push(`start:${command.commandId}`)
        if (command.commandId === id(31)) {
          markFirstStarted()
          await firstGate
        }
        order.push(`end:${command.commandId}`)
        return { ok: true, value: { result: { kind: 'completed' } } }
      },
    })
    const bootstrap = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(30), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (!bootstrap.control) throw new Error('Expected session control')
    const roomId = id(300)
    const first = coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(31), type: 'proposal.create', roomId, proposal: { kind: 'abort-hand' },
    })
    const second = coordinator.handleCommand('socket-a', bootstrap.control, {
      commandId: id(32), type: 'proposal.create', roomId, proposal: { kind: 'abort-hand' },
    })
    await firstStarted
    expect(order).toEqual([`start:${id(31)}`])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual([
      `start:${id(31)}`, `end:${id(31)}`,
      `start:${id(32)}`, `end:${id(32)}`,
    ])
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
