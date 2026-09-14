import type { AddressInfo } from 'node:net'

import {
  CommandAcknowledgementSchema,
  type ClientCommand,
  type CommandAcknowledgement,
  type LobbyUpdated,
  type RoomSnapshot,
  type ServerToClientEvents,
  type SessionReady,
} from '@cg-filipino-mahjong/shared'
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client'
import { expect, it } from 'vitest'

import {
  createBackendServer,
  type BackendServer,
  type BackendServerOptions,
} from './server.js'
import { projectRoomSnapshot, RoomService } from './room-service/index.js'

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

type TestSocket = ClientSocket<ServerToClientEvents, { command: (
  command: ClientCommand,
  acknowledge: (result: CommandAcknowledgement) => void,
) => void }>

async function start(options: BackendServerOptions = {}): Promise<{ server: BackendServer; url: string }> {
  const server = createBackendServer({ corsOrigin: '*', ...options })
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve))
  const address = server.httpServer.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function connect(url: string, auth: Record<string, unknown> = {}): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      auth,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    }) as TestSocket
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function connectWithReady(
  url: string,
  auth: Record<string, unknown>,
): Promise<{ socket: TestSocket; ready: SessionReady }> {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      auth,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    }) as TestSocket
    socket.once('connect_error', reject)
    socket.once('session.ready', (ready) => resolve({ socket, ready }))
  })
}

interface LifecycleTask {
  readonly callback: () => void
  readonly at: number
  cancelled: boolean
}

class FakeLifecycleScheduler {
  nowMs = 0
  readonly tasks: LifecycleTask[] = []

  now = () => this.nowMs

  setTimeout = (callback: () => void, delayMs: number): LifecycleTask => {
    const task = { callback, at: this.nowMs + delayMs, cancelled: false }
    this.tasks.push(task)
    return task
  }

  clearTimeout = (handle: unknown): void => {
    ;(handle as LifecycleTask).cancelled = true
  }

  advanceBy(milliseconds: number): void {
    this.nowMs += milliseconds
    for (const task of this.tasks) {
      if (task.cancelled || task.at > this.nowMs) continue
      task.cancelled = true
      task.callback()
    }
  }

  activeCount(): number {
    return this.tasks.filter((task) => !task.cancelled).length
  }
}

class TrackingRoomService extends RoomService {
  onReconnectTarget?: () => void

  override resolveReconnectTarget(reconnectCredentialInput: unknown) {
    const result = super.resolveReconnectTarget(reconnectCredentialInput)
    this.onReconnectTarget?.()
    return result
  }
}

async function flushQueues(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

function beginConnect(url: string, auth: Record<string, unknown>): TestSocket {
  return createClient(url, {
    auth,
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  }) as TestSocket
}

async function closeDuringHandshake(socket: TestSocket): Promise<void> {
  const engine = socket.io.engine
  if (!engine) throw new Error('Expected an active Engine.IO transport')
  const closed = new Promise<void>((resolve) => engine.once('close', () => resolve()))
  socket.disconnect()
  await closed
}

function reconnectWithSnapshot(
  url: string,
  auth: Record<string, unknown>,
): Promise<{ socket: TestSocket; ready: { resumed: boolean }; snapshot: RoomSnapshot }> {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      auth,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    }) as TestSocket
    let ready: { resumed: boolean } | undefined
    let snapshot: RoomSnapshot | undefined
    const finish = () => {
      if (ready && snapshot) resolve({ socket, ready, snapshot })
    }
    socket.once('connect_error', reject)
    socket.once('session.ready', (value) => {
      ready = value
      finish()
    })
    socket.once('room.snapshot', (value) => {
      snapshot = value
      finish()
    })
  })
}

function command(socket: TestSocket, value: ClientCommand): Promise<CommandAcknowledgement> {
  return new Promise((resolve) => socket.emit('command', value, resolve))
}

function nextEvent<T>(socket: TestSocket, event: 'room.snapshot' | 'lobby.updated'): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as never))
}

function nextSnapshotMatching(
  socket: TestSocket,
  predicate: (snapshot: RoomSnapshot) => boolean,
): Promise<RoomSnapshot> {
  return new Promise((resolve) => {
    const listener = (snapshot: RoomSnapshot) => {
      if (!predicate(snapshot)) return
      socket.off('room.snapshot', listener)
      resolve(snapshot)
    }
    socket.on('room.snapshot', listener)
  })
}

async function close(server: BackendServer, ...sockets: TestSocket[]): Promise<void> {
  for (const socket of sockets) socket.disconnect()
  await new Promise<void>((resolve) => server.io.close(() => resolve()))
}

it('serves health and typed Socket.IO bootstrap acknowledgements on one HTTP server', async () => {
  const { server, url } = await start()
  const socket = await connect(url)
  try {
    await expect(fetch(`${url}/api/health`).then((response) => response.json())).resolves.toEqual({ status: 'ok' })
    const ready = new Promise<{ sessionId: string; resumed: boolean }>((resolve) => socket.once('session.ready', resolve))
    const acknowledgement = await command(socket, {
      commandId: id(1), type: 'session.bootstrap', displayName: 'Ana',
    })
    expect(CommandAcknowledgementSchema.safeParse(acknowledgement).success).toBe(true)
    expect(acknowledgement).toMatchObject({ status: 'accepted', duplicate: false })
    await expect(ready).resolves.toMatchObject({ resumed: false })
  } finally {
    await close(server, socket)
  }
})

it('inspects unlisted room entry without publishing a pre-admission snapshot', async () => {
  const { server, url } = await start()
  const ana = await connect(url)
  const ben = await connect(url)
  try {
    await command(ana, { commandId: id(150), type: 'session.bootstrap', displayName: 'Ana' })
    await command(ben, { commandId: id(151), type: 'session.bootstrap', displayName: 'Ben' })
    const createdView = nextEvent<RoomSnapshot>(ana, 'room.snapshot')
    await command(ana, { commandId: id(152), type: 'room.create', visibility: 'unlisted' })
    const created = await createdView
    let snapshots = 0
    ben.on('room.snapshot', () => { snapshots += 1 })
    const inspected = await command(ben, {
      commandId: id(153), type: 'room.inspect', roomCode: created.roomCode,
    })
    expect(inspected).toMatchObject({
      status: 'accepted',
      result: { kind: 'room-entry', entry: { roomCode: created.roomCode, availableSeatCount: 3 } },
    })
    expect(snapshots).toBe(0)
    expect(JSON.stringify(inspected)).not.toContain('displayName')
    expect(JSON.stringify(inspected)).not.toContain('privateState')
  } finally {
    await close(server, ana, ben)
  }
})

it('rejects malformed commands with null IDs and invalid reconnect handshakes with structured errors', async () => {
  const { server, url } = await start()
  const socket = await connect(url)
  try {
    const malformed = await new Promise<CommandAcknowledgement>((resolve) => {
      socket.emit('command', { type: 'lobby.list' } as never, resolve)
    })
    expect(malformed).toMatchObject({
      commandId: null,
      status: 'rejected',
      error: { code: 'validation-error' },
    })

    const connectError = await new Promise<Error & { data?: { code?: string } }>((resolve) => {
      const invalid = createClient(url, {
        auth: { reconnectCredential: 'a'.repeat(32) },
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
      })
      invalid.once('connect_error', (error) => {
        invalid.disconnect()
        resolve(error)
      })
    })
    expect(connectError.data?.code).toBe('invalid-session')
  } finally {
    await close(server, socket)
  }
})

it('restores a credential on a newer controller and supersedes the old socket', async () => {
  const { server, url } = await start()
  const oldSocket = await connect(url)
  let newSocket: TestSocket | undefined
  try {
    const bootstrapped = await command(oldSocket, {
      commandId: id(10), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (bootstrapped.status !== 'accepted' || bootstrapped.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected a bootstrapped session')
    }
    const superseded = new Promise<{ reason: string }>((resolve) => oldSocket.once('session.superseded', resolve))
    const resumed = connectWithReady(url, { reconnectCredential: bootstrapped.result.reconnectCredential })
    const [supersededEvent, resumedConnection] = await Promise.all([superseded, resumed])
    newSocket = resumedConnection.socket
    expect(supersededEvent).toEqual({ reason: 'newer-connection' })
    expect(resumedConnection.ready).toMatchObject({ resumed: true })
    expect(oldSocket.connected).toBe(false)
  } finally {
    await close(server, oldSocket, ...(newSocket ? [newSocket] : []))
  }
})

it('publishes unanimous replacement proposals and commits the final vote', async () => {
  const { server, url } = await start()
  const anaSocket = await connect(url)
  const benSocket = await connect(url)
  const coraSocket = await connect(url)
  try {
    await command(anaSocket, { commandId: id(200), type: 'session.bootstrap', displayName: 'Ana' })
    await command(benSocket, { commandId: id(201), type: 'session.bootstrap', displayName: 'Ben' })
    await command(coraSocket, { commandId: id(202), type: 'session.bootstrap', displayName: 'Cora' })

    const createdEvent = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    await command(anaSocket, { commandId: id(203), type: 'room.create', visibility: 'public' })
    let room = await createdEvent
    const anaSawBen = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benJoined = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    await command(benSocket, { commandId: id(204), type: 'room.join', roomCode: room.roomCode })
    ;[room] = await Promise.all([anaSawBen, benJoined])
    const anaSawCora = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benSawCora = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    const coraJoined = nextEvent<RoomSnapshot>(coraSocket, 'room.snapshot')
    await command(coraSocket, { commandId: id(205), type: 'room.join', roomCode: room.roomCode })
    ;[room] = await Promise.all([anaSawCora, benSawCora, coraJoined])

    const configuredAna = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const configuredBen = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    const configuredCora = nextEvent<RoomSnapshot>(coraSocket, 'room.snapshot')
    await command(anaSocket, {
      commandId: id(206), type: 'room.configure-seat', roomId: room.roomId,
      expectedRoomRevision: room.roomRevision, seat: 3, controller: 'bot',
    })
    ;[room] = await Promise.all([configuredAna, configuredBen, configuredCora])

    const pausedAna = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const pausedBen = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    coraSocket.disconnect()
    ;[room] = await Promise.all([pausedAna, pausedBen])
    expect(room.pause).toEqual({ isPaused: true, disconnectedSeats: [2] })

    const proposedAna = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const proposedBen = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    const proposalAck = await command(anaSocket, {
      commandId: id(207), type: 'proposal.create', roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 2 },
    })
    expect(proposalAck.status).toBe('accepted')
    const [anaProposal, benProposal] = await Promise.all([proposedAna, proposedBen])
    expect(anaProposal.proposal).toEqual(benProposal.proposal)
    expect(anaProposal.proposal?.votes).toEqual([
      { seat: 0, status: 'approved' },
      { seat: 1, status: 'pending' },
    ])
    if (!anaProposal.proposal) throw new Error('Expected a proposal')

    const committedAna = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const committedBen = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    const voteAck = await command(benSocket, {
      commandId: id(208), type: 'proposal.vote', roomId: room.roomId,
      proposalId: anaProposal.proposal.proposalId, vote: 'approve',
    })
    expect(voteAck.status).toBe('accepted')
    const [anaCommitted, benCommitted] = await Promise.all([committedAna, committedBen])
    expect(anaCommitted.proposal).toBeNull()
    expect(anaCommitted.pause.isPaused).toBe(false)
    expect(anaCommitted.seats[2]?.controller.kind).toBe('bot')
    expect(benCommitted.roomRevision).toBe(anaCommitted.roomRevision)
  } finally {
    await close(server, anaSocket, benSocket, coraSocket)
  }
})

it('publishes tailored room snapshots and lobby updates only to unseated sessions', async () => {
  const { server, url } = await start()
  const anaSocket = await connect(url)
  const benSocket = await connect(url)
  let resumedSocket: TestSocket | undefined
  try {
    const anaInitialLobby = nextEvent<LobbyUpdated>(anaSocket, 'lobby.updated')
    const anaBootstrap = await command(anaSocket, {
      commandId: id(30), type: 'session.bootstrap', displayName: 'Ana',
    })
    await anaInitialLobby
    const benInitialLobby = nextEvent<LobbyUpdated>(benSocket, 'lobby.updated')
    const benBootstrap = await command(benSocket, {
      commandId: id(31), type: 'session.bootstrap', displayName: 'Ben',
    })
    await benInitialLobby
    if (anaBootstrap.status !== 'accepted' || anaBootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected Ana session')
    }
    if (benBootstrap.status !== 'accepted' || benBootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected Ben session')
    }

    let seatedLobbyEvents = 0
    anaSocket.on('lobby.updated', () => { seatedLobbyEvents += 1 })
    const anaCreated = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benSawRoom = nextEvent<LobbyUpdated>(benSocket, 'lobby.updated')
    await command(anaSocket, { commandId: id(32), type: 'room.create', visibility: 'public' })
    const waiting = await anaCreated
    expect((await benSawRoom).rooms).toContainEqual(expect.objectContaining({ roomId: waiting.roomId }))
    expect(seatedLobbyEvents).toBe(0)

    const anaJoinedView = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benJoinedView = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    await command(benSocket, { commandId: id(33), type: 'room.join', roomCode: waiting.roomCode })
    const [anaWaiting, benWaiting] = await Promise.all([anaJoinedView, benJoinedView])
    expect(anaWaiting.roomRevision).toBe(benWaiting.roomRevision)
    expect(anaWaiting.self.seat).toBe(0)
    expect(benWaiting.self.seat).toBe(1)

    let currentSnapshot = anaWaiting
    for (const [commandId, seat] of [[34, 2], [35, 3]] as const) {
      const nextAna = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
      const nextBen = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
      await command(anaSocket, {
        commandId: id(commandId), type: 'room.configure-seat', roomId: waiting.roomId,
        expectedRoomRevision: currentSnapshot.roomRevision, seat, controller: 'bot',
      })
      const [updatedAna] = await Promise.all([nextAna, nextBen])
      currentSnapshot = updatedAna
    }

    const anaReadyView = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benSawAnaReady = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    await command(anaSocket, {
      commandId: id(36), type: 'room.set-ready', roomId: waiting.roomId,
      readinessId: currentSnapshot.readinessId, ready: true,
    })
    const [afterAnaReady] = await Promise.all([anaReadyView, benSawAnaReady])
    const anaPlayingView = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benPlayingView = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    await command(benSocket, {
      commandId: id(37), type: 'room.set-ready', roomId: waiting.roomId,
      readinessId: afterAnaReady.readinessId, ready: true,
    })
    const [anaPlaying, benPlaying] = await Promise.all([anaPlayingView, benPlayingView])
    if (anaPlaying.stage !== 'playing' || benPlaying.stage !== 'playing') throw new Error('Expected play')
    expect(anaPlaying.roomRevision).toBe(benPlaying.roomRevision)
    expect(anaPlaying.privateState?.seat).toBe(0)
    expect(benPlaying.privateState?.seat).toBe(1)
    const anaTileIds = anaPlaying.privateState?.concealedTiles.map((tile) => tile.tileId) ?? []
    expect(benPlaying.privateState?.concealedTiles.every((tile) => !anaTileIds.includes(tile.tileId))).toBe(true)

    const pausedForAna = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    benSocket.disconnect()
    expect((await pausedForAna).pause).toMatchObject({ isPaused: true, disconnectedSeats: [1] })

    const resumed = reconnectWithSnapshot(url, { reconnectCredential: benBootstrap.result.reconnectCredential })
    const resumedConnection = await resumed
    resumedSocket = resumedConnection.socket
    expect(resumedConnection.ready.resumed).toBe(true)
    expect(resumedConnection.snapshot.self.seat).toBe(1)
    expect(resumedConnection.snapshot.pause.isPaused).toBe(false)
  } finally {
    await close(server, anaSocket, benSocket, ...(resumedSocket ? [resumedSocket] : []))
  }
})

it('suppresses an older reconnect snapshot that finishes after a newer room publication', async () => {
  let delayedSessionId: string | undefined
  let releaseDelayed!: () => void
  let hasDelayed = false
  const delayed = new Promise<void>((resolve) => { releaseDelayed = resolve })
  const { server, url } = await start({
    viewPort: {
      snapshotFor: async (control, room) => {
        const roomSeat = room.seats.find((seat) => (
          seat.controller.kind === 'human' && seat.controller.sessionId === control.sessionId
        ))
        if (!roomSeat) return undefined
        const snapshot = projectRoomSnapshot(room, roomSeat.seat)
        if (control.sessionId === delayedSessionId && !hasDelayed) {
          hasDelayed = true
          await delayed
        }
        return snapshot
      },
      roomChanged: () => undefined,
      lobbyChanged: () => undefined,
    },
  })
  const anaSocket = await connect(url)
  const benSocket = await connect(url)
  let resumedSocket: TestSocket | undefined
  try {
    const anaLobby = nextEvent<LobbyUpdated>(anaSocket, 'lobby.updated')
    await command(anaSocket, { commandId: id(40), type: 'session.bootstrap', displayName: 'Ana' })
    await anaLobby
    const benLobby = nextEvent<LobbyUpdated>(benSocket, 'lobby.updated')
    const benBootstrap = await command(benSocket, {
      commandId: id(41), type: 'session.bootstrap', displayName: 'Ben',
    })
    await benLobby
    if (benBootstrap.status !== 'accepted' || benBootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected Ben session')
    }
    const createdView = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    await command(anaSocket, { commandId: id(42), type: 'room.create', visibility: 'public' })
    const created = await createdView
    const anaJoined = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benJoined = nextEvent<RoomSnapshot>(benSocket, 'room.snapshot')
    await command(benSocket, { commandId: id(43), type: 'room.join', roomCode: created.roomCode })
    await Promise.all([anaJoined, benJoined])
    const anaSawDisconnect = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    benSocket.disconnect()
    await anaSawDisconnect

    delayedSessionId = benBootstrap.result.sessionId
    const anaSawReconnect = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const resumed = await connectWithReady(url, { reconnectCredential: benBootstrap.result.reconnectCredential })
    resumedSocket = resumed.socket
    const restoredForAna = await anaSawReconnect
    const received: RoomSnapshot[] = []
    resumedSocket.on('room.snapshot', (snapshot) => received.push(snapshot))

    const anaChanged = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    const benChanged = nextEvent<RoomSnapshot>(resumedSocket, 'room.snapshot')
    await command(anaSocket, {
      commandId: id(44), type: 'room.set-visibility', roomId: created.roomId,
      expectedRoomRevision: restoredForAna.roomRevision, visibility: 'unlisted',
    })
    const [latestAna, latestBen] = await Promise.all([anaChanged, benChanged])
    expect(latestBen.roomRevision).toBe(latestAna.roomRevision)

    releaseDelayed()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toHaveLength(1)
    expect(received[0]?.roomRevision).toBe(latestBen.roomRevision)
  } finally {
    releaseDelayed()
    await close(server, anaSocket, benSocket, ...(resumedSocket ? [resumedSocket] : []))
  }
})

it('detaches expired room subscriptions and gives late reconnects a safe lobby outcome', async () => {
  const lifecycleScheduler = new FakeLifecycleScheduler()
  const { server, url } = await start({ expirationMs: 100, lifecycleScheduler })
  const anaSocket = await connect(url)
  let resumedSocket: TestSocket | undefined
  try {
    const bootstrap = await command(anaSocket, {
      commandId: id(500), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (bootstrap.status !== 'accepted' || bootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected session')
    }
    const createdView = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    await command(anaSocket, { commandId: id(501), type: 'room.create', visibility: 'public' })
    let room = await createdView
    for (const [commandId, seat] of [[502, 1], [503, 2], [504, 3]] as const) {
      const next = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
      await command(anaSocket, {
        commandId: id(commandId), type: 'room.configure-seat', roomId: room.roomId,
        expectedRoomRevision: room.roomRevision, seat, controller: 'bot',
      })
      room = await next
    }
    const playingView = nextEvent<RoomSnapshot>(anaSocket, 'room.snapshot')
    await command(anaSocket, {
      commandId: id(505), type: 'room.set-ready', roomId: room.roomId,
      readinessId: room.readinessId, ready: true,
    })
    room = await playingView
    expect(room.stage).toBe('playing')

    await command(anaSocket, { commandId: id(506), type: 'room.leave', roomId: room.roomId })
    const unavailable = new Promise<{ code: string }>((resolve) => anaSocket.once('room.unavailable', resolve))
    const lobby = nextEvent<LobbyUpdated>(anaSocket, 'lobby.updated')
    lifecycleScheduler.advanceBy(100)
    await expect(unavailable).resolves.toMatchObject({ code: 'room-expired' })
    await expect(lobby).resolves.toMatchObject({ rooms: [] })
    expect(server.io.sockets.sockets.get(anaSocket.id ?? '')?.rooms.has(`room:${room.roomId}`)).toBe(false)

    const resumed = await connectWithReady(url, { reconnectCredential: bootstrap.result.reconnectCredential })
    resumedSocket = resumed.socket
    expect(resumed.ready).toMatchObject({
      resumed: true,
      roomError: { code: 'room-expired' },
    })
  } finally {
    await close(server, anaSocket, ...(resumedSocket ? [resumedSocket] : []))
  }
})

it('cleans up a reconnect closed after assignment and preserves room expiration and recovery', async () => {
  const lifecycleScheduler = new FakeLifecycleScheduler()
  let delayPublication = false
  let publicationStarted!: () => void
  let releasePublication!: () => void
  let publicationGate = Promise.resolve()
  const publicationEntered = new Promise<void>((resolve) => { publicationStarted = resolve })
  const { server, url } = await start({
    expirationMs: 100,
    lifecycleScheduler,
    viewPort: {
      snapshotFor: (control, room) => {
        const seat = room.seats.find((candidate) => (
          candidate.controller.kind === 'human'
          && candidate.controller.sessionId === control.sessionId
        ))
        return seat ? projectRoomSnapshot(room, seat.seat) : undefined
      },
      roomChanged: async () => {
        if (!delayPublication) return
        delayPublication = false
        publicationStarted()
        await publicationGate
      },
      lobbyChanged: () => undefined,
    },
  })
  const original = await connect(url)
  let recovered: TestSocket | undefined
  let interrupted: TestSocket | undefined
  try {
    const bootstrap = await command(original, {
      commandId: id(600), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (bootstrap.status !== 'accepted' || bootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected session')
    }
    const createdView = nextEvent<RoomSnapshot>(original, 'room.snapshot')
    await command(original, { commandId: id(601), type: 'room.create', visibility: 'public' })
    const room = await createdView
    original.disconnect()
    await expect.poll(() => server.coordinator.roomService.getRoomLifecycleTarget(room.roomId))
      .toMatchObject({ ok: true, value: { hasConnectedHuman: false } })
    expect(lifecycleScheduler.activeCount()).toBe(1)

    publicationGate = new Promise<void>((resolve) => { releasePublication = resolve })
    delayPublication = true
    interrupted = beginConnect(url, { reconnectCredential: bootstrap.result.reconnectCredential })
    let readyEvents = 0
    let snapshotEvents = 0
    interrupted.on('session.ready', () => { readyEvents += 1 })
    interrupted.on('room.snapshot', () => { snapshotEvents += 1 })
    interrupted.on('connect_error', () => undefined)
    await publicationEntered
    await closeDuringHandshake(interrupted)
    releasePublication()

    await expect.poll(() => server.coordinator.roomService.getRoomLifecycleTarget(room.roomId))
      .toMatchObject({ ok: true, value: { hasConnectedHuman: false } })
    await expect.poll(() => server.io.sockets.sockets.size).toBe(0)
    expect(readyEvents).toBe(0)
    expect(snapshotEvents).toBe(0)
    expect(lifecycleScheduler.activeCount()).toBe(1)

    const resumed = await reconnectWithSnapshot(url, {
      reconnectCredential: bootstrap.result.reconnectCredential,
    })
    recovered = resumed.socket
    expect(resumed.snapshot).toMatchObject({ roomId: room.roomId, self: { seat: 0 } })
    expect(resumed.snapshot.seats[0]?.controller).toMatchObject({ kind: 'human', connection: 'connected' })
    expect(lifecycleScheduler.activeCount()).toBe(0)

    lifecycleScheduler.advanceBy(100)
    await flushQueues()
    expect(server.coordinator.roomService.resolveRoomId(room.roomCode).ok).toBe(true)

    recovered.disconnect()
    await expect.poll(() => server.coordinator.roomService.getRoomLifecycleTarget(room.roomId))
      .toMatchObject({ ok: true, value: { hasConnectedHuman: false } })
    lifecycleScheduler.advanceBy(100)
    await flushQueues()
    const expired = server.coordinator.roomService.resolveRoomId(room.roomCode)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.error.code).toBe('room-expired')
  } finally {
    releasePublication?.()
    await close(server, original, ...(interrupted ? [interrupted] : []), ...(recovered ? [recovered] : []))
  }
})

it('keeps a newer reconnect authoritative when an earlier handshake closes before assignment', async () => {
  const roomService = new TrackingRoomService()
  const { server, url } = await start({ roomService })
  const original = await connect(url)
  let interrupted: TestSocket | undefined
  let recovered: TestSocket | undefined
  let releaseRoom!: () => void
  try {
    const bootstrap = await command(original, {
      commandId: id(610), type: 'session.bootstrap', displayName: 'Ana',
    })
    if (bootstrap.status !== 'accepted' || bootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected session')
    }
    const createdView = nextEvent<RoomSnapshot>(original, 'room.snapshot')
    await command(original, { commandId: id(611), type: 'room.create', visibility: 'public' })
    const room = await createdView
    original.disconnect()
    await expect.poll(() => roomService.getRoomLifecycleTarget(room.roomId))
      .toMatchObject({ ok: true, value: { hasConnectedHuman: false } })

    let roomOperationStarted!: () => void
    const operationStarted = new Promise<void>((resolve) => { roomOperationStarted = resolve })
    const roomGate = new Promise<void>((resolve) => { releaseRoom = resolve })
    const blockingOperation = server.coordinator.runRoomOperation(room.roomId, async () => {
      roomOperationStarted()
      await roomGate
    })
    await operationStarted

    let reconnectTargetResolved!: () => void
    const reconnectTarget = new Promise<void>((resolve) => { reconnectTargetResolved = resolve })
    roomService.onReconnectTarget = reconnectTargetResolved
    interrupted = beginConnect(url, { reconnectCredential: bootstrap.result.reconnectCredential })
    interrupted.on('connect_error', () => undefined)
    await reconnectTarget
    await closeDuringHandshake(interrupted)

    const recovering = reconnectWithSnapshot(url, {
      reconnectCredential: bootstrap.result.reconnectCredential,
    })
    releaseRoom()
    await blockingOperation
    const resumed = await recovering
    recovered = resumed.socket

    await flushQueues()
    expect(resumed.snapshot).toMatchObject({ roomId: room.roomId, self: { seat: 0 } })
    expect(roomService.getRoomLifecycleTarget(room.roomId))
      .toMatchObject({ ok: true, value: { hasConnectedHuman: true } })
    expect(server.io.sockets.sockets.size).toBe(1)
    expect(recovered.connected).toBe(true)
  } finally {
    releaseRoom?.()
    await close(server, original, ...(interrupted ? [interrupted] : []), ...(recovered ? [recovered] : []))
  }
})

it('publishes a failed reconnect as a paused replaceable seat to other humans', async () => {
  let delayPublication = false
  let publicationStarted!: () => void
  let releasePublication!: () => void
  const publicationEntered = new Promise<void>((resolve) => { publicationStarted = resolve })
  const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve })
  const { server, url } = await start({
    viewPort: {
      snapshotFor: (control, room) => {
        const seat = room.seats.find((candidate) => (
          candidate.controller.kind === 'human'
          && candidate.controller.sessionId === control.sessionId
        ))
        return seat ? projectRoomSnapshot(room, seat.seat) : undefined
      },
      roomChanged: async () => {
        if (!delayPublication) return
        delayPublication = false
        publicationStarted()
        await publicationGate
      },
      lobbyChanged: () => undefined,
    },
  })
  const ana = await connect(url)
  const ben = await connect(url)
  let interrupted: TestSocket | undefined
  try {
    await command(ana, { commandId: id(620), type: 'session.bootstrap', displayName: 'Ana' })
    const benBootstrap = await command(ben, {
      commandId: id(621), type: 'session.bootstrap', displayName: 'Ben',
    })
    if (benBootstrap.status !== 'accepted' || benBootstrap.result.kind !== 'session-bootstrapped') {
      throw new Error('Expected Ben session')
    }
    const createdView = nextEvent<RoomSnapshot>(ana, 'room.snapshot')
    await command(ana, { commandId: id(622), type: 'room.create', visibility: 'public' })
    const created = await createdView
    const anaJoined = nextEvent<RoomSnapshot>(ana, 'room.snapshot')
    const benJoined = nextEvent<RoomSnapshot>(ben, 'room.snapshot')
    await command(ben, { commandId: id(623), type: 'room.join', roomCode: created.roomCode })
    await Promise.all([anaJoined, benJoined])
    const initialPause = nextEvent<RoomSnapshot>(ana, 'room.snapshot')
    ben.disconnect()
    await initialPause

    delayPublication = true
    interrupted = beginConnect(url, { reconnectCredential: benBootstrap.result.reconnectCredential })
    interrupted.on('connect_error', () => undefined)
    await publicationEntered
    await closeDuringHandshake(interrupted)
    const pausedAgain = nextSnapshotMatching(ana, (snapshot) => snapshot.pause.isPaused)
    releasePublication()
    const paused = await pausedAgain
    expect(paused.pause).toEqual({ isPaused: true, disconnectedSeats: [1] })
    expect(paused.seats[1]?.controller).toMatchObject({ kind: 'human', connection: 'disconnected' })

    const replacement = nextEvent<RoomSnapshot>(ana, 'room.snapshot')
    const acknowledgement = await command(ana, {
      commandId: id(624), type: 'proposal.create', roomId: created.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 1 },
    })
    expect(acknowledgement.status).toBe('accepted')
    expect((await replacement).seats[1]?.controller.kind).toBe('bot')
  } finally {
    releasePublication?.()
    await close(server, ana, ben, ...(interrupted ? [interrupted] : []))
  }
})
