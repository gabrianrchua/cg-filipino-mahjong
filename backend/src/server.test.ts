import type { AddressInfo } from 'node:net'

import {
  CommandAcknowledgementSchema,
  type ClientCommand,
  type CommandAcknowledgement,
  type LobbyUpdated,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@cg-filipino-mahjong/shared'
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client'
import { expect, it } from 'vitest'

import {
  createBackendServer,
  type BackendServer,
  type BackendServerOptions,
} from './server.js'
import { projectRoomSnapshot } from './room-service/index.js'

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
): Promise<{ socket: TestSocket; ready: { resumed: boolean } }> {
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
