import { createServer, type Server as HttpServer } from 'node:http'

import {
  CommandIdSchema,
  HEALTH_RESPONSE,
  SocketAuthSchema,
  type ClientToServerEvents,
  type CommandError,
  type LobbyUpdated,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@cg-filipino-mahjong/shared'
import express, { type Express } from 'express'
import { Server as SocketServer, type Socket } from 'socket.io'

import {
  RealtimeCoordinator,
  type RealtimeCoordinatorOptions,
} from './realtime/index.js'
import type { RoomState, SessionControl } from './room-service/index.js'

interface SocketData {
  control?: SessionControl
  snapshotCursor?: {
    readonly roomId: string
    readonly roomRevision: number
  }
}

type BackendSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>

export interface BackendServerOptions extends RealtimeCoordinatorOptions {
  readonly corsOrigin?: string | string[]
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
}

function connectionError(error: CommandError): Error & { data?: CommandError } {
  const result = new Error(error.message) as Error & { data?: CommandError }
  result.data = error
  return result
}

export function createBackendServer(options: BackendServerOptions = {}): BackendServer {
  const app = express()
  const httpServer = createServer(app)
  const io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: { origin: options.corsOrigin ?? 'http://localhost:5173' },
  })
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
    },
  })

  app.use(express.json())
  app.get('/api/health', (_request, response) => {
    response.json(HEALTH_RESPONSE)
  })

  io.use((socket, next) => {
    const auth = SocketAuthSchema.safeParse(socket.handshake.auth)
    if (!auth.success) {
      next(connectionError({ code: 'validation-error', message: 'The socket authentication payload is invalid.' }))
      return
    }
    if (!auth.data.reconnectCredential) {
      next()
      return
    }
    void coordinator.authenticate(auth.data.reconnectCredential, socket.id).then((authenticated) => {
      if (!authenticated.ok) {
        next(connectionError(authenticated.error))
        return
      }
      socket.data.control = authenticated.value.control
      if (authenticated.value.room) socket.join(`room:${authenticated.value.room.roomId}`)
      if (authenticated.value.supersededControllerId) {
        const previous = io.sockets.sockets.get(authenticated.value.supersededControllerId)
        previous?.emit('session.superseded', { reason: 'newer-connection' })
        previous?.disconnect(true)
      }
      next()
    }).catch(() => {
      next(connectionError({ code: 'internal-error', message: 'The session could not be authenticated.' }))
    })
  })

  io.on('connection', (socket) => {
    if (socket.data.control) {
      const control = socket.data.control
      socket.emit('session.ready', { sessionId: control.sessionId, resumed: true })
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

    socket.on('disconnect', () => {
      if (socket.data.control) void coordinator.disconnect(socket.data.control)
    })
  })

  return { app, httpServer, io, coordinator }
}
