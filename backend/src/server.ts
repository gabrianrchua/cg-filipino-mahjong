import { createServer, type Server as HttpServer } from 'node:http'
import { extname } from 'node:path'

import {
  ClientCommandSchema,
  CommandIdSchema,
  HEALTH_RESPONSE,
  SocketAuthSchema,
  type ClientToServerEvents,
  type CommandError,
  type LobbyUpdated,
  type RoomUnavailable,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@cg-filipino-mahjong/shared'
import express, { type Express } from 'express'
import { Server as SocketServer, type Socket } from 'socket.io'

import {
  RealtimeCoordinator,
  type RealtimeCoordinatorOptions,
} from './realtime/index.js'
import {
  logOperational,
  silentOperationalLogger,
} from './operational-logger.js'
import type { RoomState, SessionControl } from './room-service/index.js'

interface SocketData {
  control?: SessionControl
  roomError?: RoomUnavailable
  connectionLifecycle?: SocketConnectionLifecycle
  snapshotCursor?: {
    readonly roomId: string
    readonly roomRevision: number
  }
}

interface SocketConnectionLifecycle {
  readonly onTransportClose: () => void
  readonly requestCleanup: () => Promise<void>
  readonly transportClosed: () => boolean
}

type BackendSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>

export interface BackendServerOptions extends RealtimeCoordinatorOptions {
  readonly corsOrigin?: string | string[]
  readonly frontendDistPath?: string
  readonly shutdownTimeoutMs?: number
}

export interface BackendServer {
  readonly app: Express
  readonly httpServer: HttpServer
  readonly io: SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >
  readonly coordinator: RealtimeCoordinator
  shutdown(): Promise<void>
}

function connectionError(error: CommandError): Error & { data?: CommandError } {
  const result = new Error(error.message) as Error & { data?: CommandError }
  result.data = error
  return result
}

function validShutdownTimeout(value: number | undefined): number {
  const resolved = value ?? 10_000
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('shutdownTimeoutMs must be a positive safe integer.')
  }
  return resolved
}

export function createBackendServer(options: BackendServerOptions = {}): BackendServer {
  const logger = options.logger ?? silentOperationalLogger
  const app = express()
  const httpServer = createServer(app)
  const io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, options.corsOrigin === undefined
    ? {}
    : { cors: { origin: options.corsOrigin } })
  let coordinator!: RealtimeCoordinator

  const emitFreshSnapshot = (
    socket: BackendSocket,
    snapshot: RoomSnapshot,
  ): void => {
    const cursor = socket.data.snapshotCursor
    if (
      cursor?.roomId === snapshot.roomId
      && snapshot.roomRevision < cursor.roomRevision
    ) return
    socket.data.snapshotCursor = {
      roomId: snapshot.roomId,
      roomRevision: snapshot.roomRevision,
    }
    socket.emit('room.snapshot', snapshot)
  }

  const lobbyFor = (control: SessionControl): LobbyUpdated | undefined => {
    const currentRoom = coordinator.roomService.getControlledRoom(control)
    if (!currentRoom.ok || currentRoom.value !== null) return undefined
    const listed = coordinator.roomService.listPublicRooms(control)
    return listed.ok ? { rooms: [...listed.value.rooms] } : undefined
  }

  const emitLobbyTo = (socket: BackendSocket): void => {
    if (!socket.data.control) return
    const lobby = lobbyFor(socket.data.control)
    if (lobby) socket.emit('lobby.updated', lobby)
  }

  const snapshotFor = async (control: SessionControl, room: RoomState) => {
    if (options.viewPort) return options.viewPort.snapshotFor(control, room)
    const projected = coordinator.roomService.getRecipientSnapshot(control, room.roomId)
    return projected.ok ? projected.value : undefined
  }

  coordinator = new RealtimeCoordinator({
    ...options,
    viewPort: {
      snapshotFor,
      roomChanged: async (room) => {
        await options.viewPort?.roomChanged(room)
        await Promise.all([...io.sockets.sockets.values()].map(async (socket) => {
          if (!socket.data.control) return
          const snapshot = await snapshotFor(socket.data.control, room)
          if (snapshot && socket.connected) emitFreshSnapshot(socket, snapshot)
        }))
      },
      lobbyChanged: async () => {
        await options.viewPort?.lobbyChanged()
        for (const socket of io.sockets.sockets.values()) emitLobbyTo(socket)
      },
      roomExpired: async (expiration) => {
        await options.viewPort?.roomExpired?.(expiration)
        const detached = new Set(expiration.detachedSessionIds)
        await Promise.all([...io.sockets.sockets.values()].map(async (socket) => {
          if (!socket.data.control || !detached.has(socket.data.control.sessionId)) return
          await socket.leave(`room:${expiration.roomId}`)
          socket.data.snapshotCursor = undefined
          socket.emit('room.unavailable', { code: 'room-expired', message: 'The room has expired.' })
        }))
      },
    },
  })
  httpServer.once('close', () => coordinator.dispose())

  app.use(express.json())
  app.get('/api/health', (_request, response) => {
    response.json(HEALTH_RESPONSE)
  })
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'not-found' })
  })

  if (options.frontendDistPath) {
    app.use(express.static(options.frontendDistPath, { index: false }))
    app.use((request, response, next) => {
      const isNavigation = request.method === 'GET'
        && request.accepts('html') !== false
        && !request.path.startsWith('/api/')
        && !request.path.startsWith('/socket.io/')
        && extname(request.path) === ''
      if (!isNavigation) {
        next()
        return
      }
      response.sendFile('index.html', { root: options.frontendDistPath })
    })
  }

  io.use((socket, next) => {
    let closed = false
    let cleanup: Promise<void> | undefined
    const requestCleanup = (): Promise<void> => {
      closed = true
      if (!socket.data.control) return Promise.resolve()
      cleanup ??= coordinator.disconnect(socket.data.control).catch(() => undefined)
      return cleanup
    }
    const onTransportClose = (): void => {
      void requestCleanup()
    }
    const connectionLifecycle: SocketConnectionLifecycle = {
      onTransportClose,
      requestCleanup,
      transportClosed: () => closed,
    }
    socket.data.connectionLifecycle = connectionLifecycle
    socket.conn.once('close', onTransportClose)

    const auth = SocketAuthSchema.safeParse(socket.handshake.auth)
    if (!auth.success) {
      logOperational(logger, 'warn', 'connection.authentication_failed', {
        errorCode: 'validation-error',
      })
      next(connectionError({ code: 'validation-error', message: 'The socket authentication payload is invalid.' }))
      return
    }
    if (!auth.data.reconnectCredential) {
      next()
      return
    }
    void coordinator.authenticate(auth.data.reconnectCredential, socket.id).then((authenticated) => {
      if (!authenticated.ok) {
        logOperational(logger, 'warn', 'connection.authentication_failed', {
          errorCode: authenticated.error.code,
        })
        next(connectionError(authenticated.error))
        return
      }
      socket.data.control = authenticated.value.control
      socket.data.roomError = authenticated.value.roomError
      if (authenticated.value.supersededControllerId) {
        const previous = io.sockets.sockets.get(authenticated.value.supersededControllerId)
        previous?.emit('session.superseded', { reason: 'newer-connection' })
        previous?.disconnect(true)
      }
      if (connectionLifecycle.transportClosed()) {
        void connectionLifecycle.requestCleanup().then(() => {
          next(connectionError({ code: 'internal-error', message: 'The connection closed during authentication.' }))
        })
        return
      }
      if (authenticated.value.room) socket.join(`room:${authenticated.value.room.roomId}`)
      next()
    }).catch(() => {
      logOperational(logger, 'error', 'connection.authentication_failed', {
        errorCode: 'internal-error',
      })
      next(connectionError({ code: 'internal-error', message: 'The session could not be authenticated.' }))
    })
  })

  io.on('connection', (socket) => {
    const connectionLifecycle = socket.data.connectionLifecycle
    if (connectionLifecycle) {
      socket.on('disconnect', () => {
        void connectionLifecycle.requestCleanup()
      })
      socket.conn.off('close', connectionLifecycle.onTransportClose)
    }

    if (socket.data.control) {
      const control = socket.data.control
      socket.emit('session.ready', {
        sessionId: control.sessionId,
        resumed: true,
        ...(socket.data.roomError ? { roomError: socket.data.roomError } : {}),
      })
      socket.data.roomError = undefined
      const roomName = [...socket.rooms].find((room) => room.startsWith('room:'))
      if (roomName) {
        const room = coordinator.roomService.getRoom(control, roomName.slice(5))
        if (room.ok) {
          void Promise.resolve(coordinator.snapshotFor(control, room.value)).then((snapshot) => {
            if (snapshot && socket.connected) emitFreshSnapshot(socket, snapshot)
          })
        }
      } else {
        emitLobbyTo(socket)
      }
    }

    socket.on('command', (input: unknown, acknowledge) => {
      void coordinator.handleCommand(socket.id, socket.data.control, input).then(async (handled) => {
        if (handled.control) {
          socket.data.control = handled.control
        }
        if (handled.room) {
          await socket.join(`room:${handled.room.roomId}`)
        }
        if (handled.leftRoomId) {
          await socket.leave(`room:${handled.leftRoomId}`)
        }
        if (typeof acknowledge === 'function') acknowledge(handled.acknowledgement)
        if (handled.control) {
          socket.emit('session.ready', { sessionId: handled.control.sessionId, resumed: false })
          emitLobbyTo(socket)
        }
      }).catch(() => {
        const parsedCommand = ClientCommandSchema.safeParse(input)
        logOperational(logger, 'error', 'command.failed', {
          commandType: parsedCommand.success ? parsedCommand.data.type : 'unknown',
          errorCode: 'internal-error',
        })
        const parsedId = CommandIdSchema.safeParse(typeof input === 'object' && input !== null && 'commandId' in input
          ? input.commandId
          : undefined)
        if (typeof acknowledge === 'function') {
          acknowledge({
            commandId: parsedId.success ? parsedId.data : null,
            status: 'rejected',
            duplicate: false,
            error: { code: 'internal-error', message: 'The command could not be processed.' },
          })
        }
      })
    })

  })

  io.engine.on('connection_error', (error) => {
    logOperational(logger, 'warn', 'connection.transport_failed', {
      errorCode: String(error.code),
    })
  })

  const shutdownTimeoutMs = validShutdownTimeout(options.shutdownTimeoutMs)
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= new Promise<void>((resolve) => {
      logOperational(logger, 'info', 'server.shutdown_started')
      coordinator.dispose()
      let finished = false
      const finish = (forced: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        logOperational(logger, forced ? 'warn' : 'info', 'server.shutdown_completed', { forced })
        resolve()
      }
      const timeout = setTimeout(() => {
        io.disconnectSockets(true)
        httpServer.closeAllConnections()
        finish(true)
      }, shutdownTimeoutMs)
      timeout.unref()
      io.close(() => finish(false))
    })
    return shutdownPromise
  }

  return { app, httpServer, io, coordinator, shutdown }
}
