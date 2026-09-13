import type { AddressInfo } from 'node:net'

import {
  CommandAcknowledgementSchema,
  type ClientCommand,
  type CommandAcknowledgement,
  type ServerToClientEvents,
} from '@cg-filipino-mahjong/shared'
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client'
import { expect, it } from 'vitest'

import { createBackendServer, type BackendServer } from './server.js'

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

type TestSocket = ClientSocket<ServerToClientEvents, { command: (
  command: ClientCommand,
  acknowledge: (result: CommandAcknowledgement) => void,
) => void }>

async function start(): Promise<{ server: BackendServer; url: string }> {
  const server = createBackendServer({ corsOrigin: '*' })
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

function command(socket: TestSocket, value: ClientCommand): Promise<CommandAcknowledgement> {
  return new Promise((resolve) => socket.emit('command', value, resolve))
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
