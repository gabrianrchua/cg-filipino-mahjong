import { z } from 'zod'

import {
  CommandIdSchema,
  HandIdSchema,
  PhaseIdSchema,
  ProposalIdSchema,
  ReadinessIdSchema,
  ReconnectCredentialSchema,
  RevisionSchema,
  RoomIdSchema,
  SessionIdSchema,
  TakeoverIdSchema,
} from './primitives.js'
import { LobbySummarySchema, RoomSnapshotSchema } from './views.js'

export const CommandErrorCodeSchema = z.enum([
  'validation-error',
  'invalid-session',
  'session-superseded',
  'unauthorized',
  'room-not-found',
  'room-expired',
  'room-full',
  'already-seated',
  'not-seated',
  'invalid-room-state',
  'invalid-controller',
  'seat-unavailable',
  'takeover-pending',
  'command-conflict',
  'stale-room',
  'stale-readiness',
  'stale-hand',
  'stale-phase',
  'already-responded',
  'action-not-legal',
  'room-paused',
  'proposal-active',
  'proposal-not-found',
  'vote-not-eligible',
  'rate-limited',
  'internal-error',
])

export const CommandErrorDetailsSchema = z.strictObject({
  roomId: RoomIdSchema.optional(),
  currentRoomRevision: RevisionSchema.optional(),
  currentReadinessId: ReadinessIdSchema.optional(),
  currentHandId: HandIdSchema.optional(),
  currentPhaseId: PhaseIdSchema.optional(),
  currentProposalId: ProposalIdSchema.optional(),
})

export const CommandErrorSchema = z.strictObject({
  code: CommandErrorCodeSchema,
  message: z.string().min(1).max(160),
  details: CommandErrorDetailsSchema.optional(),
})

export const CommandResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session-bootstrapped'),
    sessionId: SessionIdSchema,
    reconnectCredential: ReconnectCredentialSchema,
  }),
  z.strictObject({
    kind: z.literal('lobby-rooms'),
    rooms: z.array(LobbySummarySchema).max(100),
  }),
  z.strictObject({
    kind: z.literal('room-snapshot'),
    snapshot: RoomSnapshotSchema,
  }),
  z.strictObject({
    kind: z.literal('takeover-pending'),
    takeoverId: TakeoverIdSchema,
  }),
  z.strictObject({ kind: z.literal('completed') }),
])

export const AcceptedCommandAcknowledgementSchema = z.strictObject({
  commandId: CommandIdSchema,
  status: z.literal('accepted'),
  duplicate: z.boolean(),
  result: CommandResultSchema,
})

export const RejectedCommandAcknowledgementSchema = z.strictObject({
  commandId: CommandIdSchema,
  status: z.literal('rejected'),
  duplicate: z.boolean(),
  error: CommandErrorSchema,
  snapshot: RoomSnapshotSchema.optional(),
})

export const CommandAcknowledgementSchema = z.discriminatedUnion('status', [
  AcceptedCommandAcknowledgementSchema,
  RejectedCommandAcknowledgementSchema,
])

export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>
export type CommandError = z.infer<typeof CommandErrorSchema>
export type CommandResult = z.infer<typeof CommandResultSchema>
export type AcceptedCommandAcknowledgement = z.infer<typeof AcceptedCommandAcknowledgementSchema>
export type RejectedCommandAcknowledgement = z.infer<typeof RejectedCommandAcknowledgementSchema>
export type CommandAcknowledgement = z.infer<typeof CommandAcknowledgementSchema>
