import { z } from 'zod'

import {
  ChoiceIdSchema,
  CommandIdSchema,
  DisplayNameSchema,
  HandIdSchema,
  PhaseIdSchema,
  ProposalIdSchema,
  ReadinessIdSchema,
  ReconnectCredentialSchema,
  RevisionSchema,
  RoomCodeSchema,
  RoomIdSchema,
  SeatSchema,
  VisibilitySchema,
} from './primitives.js'

const commandId = { commandId: CommandIdSchema }

export const SessionBootstrapCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('session.bootstrap'),
  displayName: DisplayNameSchema,
})

export const LobbyListCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('lobby.list'),
})

export const RoomInspectCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.inspect'),
  roomCode: RoomCodeSchema,
})

export const RoomCreateCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.create'),
  visibility: VisibilitySchema,
})

export const RoomJoinCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.join'),
  roomCode: RoomCodeSchema,
})

export const RoomSpectateCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.spectate'),
  roomCode: RoomCodeSchema,
})

export const RoomSetVisibilityCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.set-visibility'),
  roomId: RoomIdSchema,
  expectedRoomRevision: RevisionSchema,
  visibility: VisibilitySchema,
})

export const RoomConfigureSeatCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.configure-seat'),
  roomId: RoomIdSchema,
  expectedRoomRevision: RevisionSchema,
  seat: SeatSchema,
  controller: z.enum(['available', 'bot']),
})

export const RoomSetReadyCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.set-ready'),
  roomId: RoomIdSchema,
  readinessId: ReadinessIdSchema,
  ready: z.boolean(),
})

export const GameplayActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('discard'), choiceId: ChoiceIdSchema }),
  z.strictObject({ kind: z.literal('win'), choiceId: ChoiceIdSchema }),
  z.strictObject({ kind: z.literal('secret'), choiceId: ChoiceIdSchema }),
  z.strictObject({ kind: z.literal('sagasa'), choiceId: ChoiceIdSchema }),
  z.strictObject({ kind: z.literal('respond-to-discard'), choiceId: ChoiceIdSchema }),
])

export const GameActionCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('game.action'),
  roomId: RoomIdSchema,
  handId: HandIdSchema,
  phaseId: PhaseIdSchema,
  action: GameplayActionSchema,
})

export const ProposalCreateCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('proposal.create'),
  roomId: RoomIdSchema,
  proposal: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('abort-hand') }),
    z.strictObject({ kind: z.literal('replace-with-bot'), targetSeat: SeatSchema }),
  ]),
})

export const ProposalVoteCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('proposal.vote'),
  roomId: RoomIdSchema,
  proposalId: ProposalIdSchema,
  vote: z.enum(['approve', 'reject']),
})

export const RoomLeaveCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.leave'),
  roomId: RoomIdSchema,
})

export const RoomTakeoverCommandSchema = z.strictObject({
  ...commandId,
  type: z.literal('room.takeover'),
  roomCode: RoomCodeSchema,
  seat: SeatSchema,
})

export const ClientCommandSchema = z.discriminatedUnion('type', [
  SessionBootstrapCommandSchema,
  LobbyListCommandSchema,
  RoomInspectCommandSchema,
  RoomCreateCommandSchema,
  RoomJoinCommandSchema,
  RoomSpectateCommandSchema,
  RoomSetVisibilityCommandSchema,
  RoomConfigureSeatCommandSchema,
  RoomSetReadyCommandSchema,
  GameActionCommandSchema,
  ProposalCreateCommandSchema,
  ProposalVoteCommandSchema,
  RoomLeaveCommandSchema,
  RoomTakeoverCommandSchema,
])

export const SocketAuthSchema = z.strictObject({
  reconnectCredential: ReconnectCredentialSchema.optional(),
})

export type GameplayAction = z.infer<typeof GameplayActionSchema>
export type SessionBootstrapCommand = z.infer<typeof SessionBootstrapCommandSchema>
export type LobbyListCommand = z.infer<typeof LobbyListCommandSchema>
export type RoomInspectCommand = z.infer<typeof RoomInspectCommandSchema>
export type RoomCreateCommand = z.infer<typeof RoomCreateCommandSchema>
export type RoomJoinCommand = z.infer<typeof RoomJoinCommandSchema>
export type RoomSpectateCommand = z.infer<typeof RoomSpectateCommandSchema>
export type RoomSetVisibilityCommand = z.infer<typeof RoomSetVisibilityCommandSchema>
export type RoomConfigureSeatCommand = z.infer<typeof RoomConfigureSeatCommandSchema>
export type RoomSetReadyCommand = z.infer<typeof RoomSetReadyCommandSchema>
export type GameActionCommand = z.infer<typeof GameActionCommandSchema>
export type ProposalCreateCommand = z.infer<typeof ProposalCreateCommandSchema>
export type ProposalVoteCommand = z.infer<typeof ProposalVoteCommandSchema>
export type RoomLeaveCommand = z.infer<typeof RoomLeaveCommandSchema>
export type RoomTakeoverCommand = z.infer<typeof RoomTakeoverCommandSchema>
export type ClientCommand = z.infer<typeof ClientCommandSchema>
export type SocketAuth = z.infer<typeof SocketAuthSchema>
