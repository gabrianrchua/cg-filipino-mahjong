import { z } from 'zod'

import type { CommandAcknowledgement } from './acknowledgements.js'
import type { ClientCommand } from './commands.js'
import { SessionIdSchema } from './primitives.js'
import {
  LobbySummarySchema,
  type RoomSnapshot,
} from './views.js'

export const SessionReadySchema = z.strictObject({
  sessionId: SessionIdSchema,
  resumed: z.boolean(),
})

export const LobbyUpdatedSchema = z.strictObject({
  rooms: z.array(LobbySummarySchema).max(100),
})

export const SessionSupersededSchema = z.strictObject({
  reason: z.literal('newer-connection'),
})

export interface ClientToServerEvents {
  command: (
    command: ClientCommand,
    acknowledge: (acknowledgement: CommandAcknowledgement) => void,
  ) => void
}

export interface ServerToClientEvents {
  'session.ready': (session: SessionReady) => void
  'lobby.updated': (lobby: LobbyUpdated) => void
  'room.snapshot': (snapshot: RoomSnapshot) => void
  'session.superseded': (event: SessionSuperseded) => void
}

export type SessionReady = z.infer<typeof SessionReadySchema>
export type LobbyUpdated = z.infer<typeof LobbyUpdatedSchema>
export type SessionSuperseded = z.infer<typeof SessionSupersededSchema>
