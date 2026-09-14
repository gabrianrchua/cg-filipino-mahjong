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

interface LifecycleTask {
  readonly callback: () => void
  readonly at: number
  cancelled: boolean
  fired: boolean
}

class FakeLifecycleScheduler {
  nowMs = 0
  readonly tasks: LifecycleTask[] = []

  now = () => this.nowMs

  setTimeout = (callback: () => void, delayMs: number): LifecycleTask => {
    const task = { callback, at: this.nowMs + delayMs, cancelled: false, fired: false }
    this.tasks.push(task)
    return task
  }

  clearTimeout = (handle: unknown): void => {
    ;(handle as LifecycleTask).cancelled = true
  }

  advanceBy(milliseconds: number): void {
    this.nowMs += milliseconds
    for (const task of this.tasks) {
      if (task.cancelled || task.fired || task.at > this.nowMs) continue
      task.fired = true
      task.callback()
    }
  }

  activeCount(): number {
    return this.tasks.filter((task) => !task.cancelled && !task.fired).length
  }
}

async function flushQueues(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('realtime coordinator', () => {
  it('expires a room at the deadline, resets departure time after reconnect, and reports late recovery', async () => {
    const scheduler = new FakeLifecycleScheduler()
    const expirations: string[] = []
    const coordinator = new RealtimeCoordinator({
      expirationMs: 100,
      lifecycleScheduler: scheduler,
      viewPort: {
        snapshotFor: () => undefined,
        roomChanged: () => undefined,
        lobbyChanged: () => undefined,
        roomExpired: (expiration) => { expirations.push(expiration.roomId) },
      },
    })
    const bootstrapped = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(900), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (
      !bootstrapped.control
      || bootstrapped.acknowledgement.status !== 'accepted'
      || bootstrapped.acknowledgement.result.kind !== 'session-bootstrapped'
    ) throw new Error('Expected session')
    const credential = bootstrapped.acknowledgement.result.reconnectCredential
    const created = await coordinator.handleCommand('socket-a', bootstrapped.control, {
      commandId: id(901), type: 'room.create', visibility: 'public',
    })
    if (!created.room) throw new Error('Expected room')
    const room = created.room

    await coordinator.disconnect(bootstrapped.control)
    expect(scheduler.activeCount()).toBe(1)
    const staleExpiry = scheduler.tasks[0]!
    scheduler.advanceBy(99)
    await flushQueues()
    expect(coordinator.roomService.resolveRoomId(room.roomCode).ok).toBe(true)

    const returned = await coordinator.authenticate(credential, 'socket-returned')
    if (!returned.ok) throw new Error('Expected reconnect')
    expect(staleExpiry.cancelled).toBe(true)
    staleExpiry.callback()
    await flushQueues()
    expect(coordinator.roomService.resolveRoomId(room.roomCode).ok).toBe(true)

    await coordinator.disconnect(returned.value.control)
    scheduler.advanceBy(99)
    await flushQueues()
    expect(coordinator.roomService.resolveRoomId(room.roomCode).ok).toBe(true)
    scheduler.advanceBy(1)
    await flushQueues()
    const missing = coordinator.roomService.resolveRoomId(room.roomCode)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('room-expired')
    expect(expirations).toEqual([room.roomId])

    const late = await coordinator.authenticate(credential, 'socket-late')
    expect(late.ok && late.value.room).toBeNull()
    expect(late.ok && late.value.roomError).toEqual({ code: 'room-expired', message: 'The room has expired.' })
    expect(scheduler.activeCount()).toBe(0)
  })

  it('expires only unattached inactive sessions and protects credentials reserved by rooms', async () => {
    const scheduler = new FakeLifecycleScheduler()
    const coordinator = new RealtimeCoordinator({ expirationMs: 100, lifecycleScheduler: scheduler })
    const unseated = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(910), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (
      !unseated.control
      || unseated.acknowledgement.status !== 'accepted'
      || unseated.acknowledgement.result.kind !== 'session-bootstrapped'
    ) throw new Error('Expected session')
    const credential = unseated.acknowledgement.result.reconnectCredential
    await coordinator.disconnect(unseated.control)
    scheduler.advanceBy(99)
    await flushQueues()
    expect(coordinator.roomService.resolveReconnectTarget(credential).ok).toBe(true)
    scheduler.advanceBy(1)
    await flushQueues()
    expect(coordinator.roomService.resolveReconnectTarget(credential).ok).toBe(false)

    const reserved = await coordinator.handleCommand('socket-b', undefined, {
      commandId: id(911), type: 'session.bootstrap', displayName: 'Ben',
    })
    if (
      !reserved.control
      || reserved.acknowledgement.status !== 'accepted'
      || reserved.acknowledgement.result.kind !== 'session-bootstrapped'
    ) throw new Error('Expected reserved session')
    const reservedCredential = reserved.acknowledgement.result.reconnectCredential
    await coordinator.handleCommand('socket-b', reserved.control, {
      commandId: id(912), type: 'room.create', visibility: 'public',
    })
    await coordinator.disconnect(reserved.control)
    scheduler.advanceBy(100)
    await flushQueues()
    expect(coordinator.roomService.resolveReconnectTarget(reservedCredential).ok).toBe(true)
  })

  it('cancels room expiry only after a bot-seat takeover successfully commits', async () => {
    const scheduler = new FakeLifecycleScheduler()
    const coordinator = new RealtimeCoordinator({ expirationMs: 100, lifecycleScheduler: scheduler })
    const ana = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(930), type: 'session.bootstrap', displayName: 'Ana',
    })
    const ben = await coordinator.handleCommand('socket-b', undefined, {
      commandId: id(931), type: 'session.bootstrap', displayName: 'Ben',
    })
    if (!ana.control || !ben.control) throw new Error('Expected sessions')
    const created = await coordinator.handleCommand('socket-a', ana.control, {
      commandId: id(932), type: 'room.create', visibility: 'public',
    })
    if (!created.room) throw new Error('Expected room')
    const configured = await coordinator.handleCommand('socket-a', ana.control, {
      commandId: id(933), type: 'room.configure-seat', roomId: created.room.roomId,
      expectedRoomRevision: created.room.roomRevision, seat: 1, controller: 'bot',
    })
    if (!configured.room) throw new Error('Expected bot seat')

    await coordinator.disconnect(ana.control)
    const expiry = scheduler.tasks.find((task) => !task.cancelled && !task.fired)
    expect(expiry).toBeDefined()
    const takeover = await coordinator.handleCommand('socket-b', ben.control, {
      commandId: id(934), type: 'room.takeover', roomCode: configured.room.roomCode, seat: 1,
    })
    expect(takeover.acknowledgement.status).toBe('accepted')
    expect(expiry?.cancelled).toBe(true)
    expiry?.callback()
    await flushQueues()
    expect(coordinator.roomService.resolveRoomId(configured.room.roomCode).ok).toBe(true)
  })

  it('guards an old expiry callback from a newly created room with reused identifiers', async () => {
    const scheduler = new FakeLifecycleScheduler()
    const identifiers = [id(920), id(999), id(921), id(922), id(999), id(923)]
    const roomService = new RoomService({
      createId: () => identifiers.shift() ?? id(998),
      createCredential: (() => {
        let value = 0
        return () => `credential_${String(value++).padStart(40, '0')}`
      })(),
      createRoomCode: () => 'ABC234',
    })
    const coordinator = new RealtimeCoordinator({ roomService, expirationMs: 100, lifecycleScheduler: scheduler })
    const ana = roomService.bootstrapSession('Ana', 'socket-a')
    if (!ana.ok) throw new Error('Expected Ana')
    const first = await coordinator.handleCommand('socket-a', ana.value.control, {
      commandId: id(924), type: 'room.create', visibility: 'public',
    })
    if (!first.room) throw new Error('Expected first room')
    await coordinator.disconnect(ana.value.control)
    const oldTask = scheduler.tasks[0]!
    const removed = roomService.expireRoom(first.room.roomId)
    if (!removed.ok) throw new Error('Expected direct cleanup')

    const ben = roomService.bootstrapSession('Ben', 'socket-b')
    if (!ben.ok) throw new Error('Expected Ben')
    const replacement = await coordinator.handleCommand('socket-b', ben.value.control, {
      commandId: id(925), type: 'room.create', visibility: 'public',
    })
    if (!replacement.room) throw new Error('Expected replacement room')
    expect(replacement.room.roomId).toBe(first.room.roomId)
    expect(replacement.room.roomCode).toBe(first.room.roomCode)

    oldTask.callback()
    await flushQueues()
    expect(roomService.resolveRoomId(replacement.room.roomCode).ok).toBe(true)
  })

  it('removes room and session deduplication history with their lifecycle owners', async () => {
    const scheduler = new FakeLifecycleScheduler()
    const coordinator = new RealtimeCoordinator({ expirationMs: 100, lifecycleScheduler: scheduler })
    const bootstrapped = await coordinator.handleCommand('socket-a', undefined, {
      commandId: id(940), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (!bootstrapped.control) throw new Error('Expected session')
    const createCommand = { commandId: id(941), type: 'room.create', visibility: 'public' } as const
    const created = await coordinator.handleCommand('socket-a', bootstrapped.control, createCommand)
    if (!created.room) throw new Error('Expected room')
    const expired = await coordinator.expireRoom(created.room.roomId)
    if (!expired.ok) throw new Error('Expected expiry')

    const recreated = await coordinator.handleCommand('socket-a', bootstrapped.control, createCommand)
    expect(recreated.acknowledgement).toMatchObject({ status: 'accepted', duplicate: false })
    if (!recreated.room) throw new Error('Expected a newly applied create')
    await coordinator.expireRoom(recreated.room.roomId)
    await coordinator.disconnect(bootstrapped.control)
    scheduler.advanceBy(100)
    await flushQueues()

    const afterSessionExpiry = await coordinator.handleCommand('socket-a', bootstrapped.control, createCommand)
    expect(afterSessionExpiry.acknowledgement).toMatchObject({
      status: 'rejected',
      duplicate: false,
      error: { code: 'invalid-session' },
    })
  })

  it('returns bounded room, session, and timer resources to baseline across repeated cycles', async () => {
    const scheduler = new FakeLifecycleScheduler()
    const roomService = new RoomService({ maxRooms: 1, maxSessions: 1 })
    const coordinator = new RealtimeCoordinator({
      roomService,
      expirationMs: 10,
      lifecycleScheduler: scheduler,
    })

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const controllerId = `cycle-socket-${cycle}`
      const bootstrapped = await coordinator.handleCommand(controllerId, undefined, {
        commandId: id(950 + cycle * 2), type: 'session.bootstrap', displayName: `Guest ${cycle}`,
      })
      if (!bootstrapped.control) throw new Error('Expected session allocation')
      const created = await coordinator.handleCommand(controllerId, bootstrapped.control, {
        commandId: id(951 + cycle * 2), type: 'room.create', visibility: 'public',
      })
      if (!created.room) throw new Error('Expected room allocation')
      await coordinator.disconnect(bootstrapped.control)

      scheduler.advanceBy(10)
      await flushQueues()
      expect(roomService.resolveRoomId(created.room.roomCode).ok).toBe(false)
      scheduler.advanceBy(10)
      await flushQueues()
      expect(scheduler.activeCount()).toBe(0)
    }
  })

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
