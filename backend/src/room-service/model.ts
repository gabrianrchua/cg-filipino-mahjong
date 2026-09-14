import type {
  ChoiceId,
  CommandError,
  DisplayName,
  GameplayAction,
  HandId,
  LegalChoice,
  LobbySummary,
  ReadinessId,
  ReconnectCredential,
  Revision,
  RoomCode,
  RoomId,
  Seat,
  SessionId,
  PhaseId,
  Proposal,
  ProposalId,
  Visibility,
} from '@cg-filipino-mahjong/shared'

import type { EngineState } from '../game-engine/index.js'

export interface SessionControl {
  readonly sessionId: SessionId
  readonly controllerId: string
}

export interface GuestSession {
  readonly sessionId: SessionId
  readonly displayName: DisplayName
  readonly roomId: RoomId | null
  readonly hasActiveController: boolean
}

export type RoomSeatController =
  | { readonly kind: 'available' }
  | { readonly kind: 'bot' }
  | {
      readonly kind: 'human'
      readonly sessionId: SessionId
      readonly displayName: DisplayName
      readonly connected: boolean
      readonly ready: boolean
    }

export interface RoomSeat {
  readonly seat: Seat
  readonly controller: RoomSeatController
}

export type FourRoomSeats = readonly [RoomSeat, RoomSeat, RoomSeat, RoomSeat]

export type RoomStage =
  | { readonly kind: 'waiting' }
  | {
      readonly kind: 'playing'
      readonly handId: HandId
      readonly phaseId: PhaseId
      readonly gameRevision: Revision
      readonly engineState: EngineState
    }
  | {
      readonly kind: 'between-hands'
      readonly handId: HandId
      readonly gameRevision: Revision
      readonly engineState: EngineState
    }

export interface RoomState {
  readonly roomId: RoomId
  readonly roomCode: RoomCode
  readonly visibility: Visibility
  readonly roomRevision: Revision
  readonly readinessId: ReadinessId
  readonly seats: FourRoomSeats
  readonly stage: RoomStage
  readonly proposal: Proposal | null
}

export type CollectiveProposalInput =
  | { readonly kind: 'abort-hand' }
  | { readonly kind: 'replace-with-bot'; readonly targetSeat: Seat }

export interface ProposalCreateInput {
  readonly roomId: RoomId
  readonly proposal: CollectiveProposalInput
}

export interface ProposalVoteInput {
  readonly roomId: RoomId
  readonly proposalId: ProposalId
  readonly vote: 'approve' | 'reject'
}

export type RoomServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError }

export interface SessionBootstrap {
  readonly session: GuestSession
  readonly control: SessionControl
  readonly reconnectCredential: ReconnectCredential
}

export interface SessionAuthentication {
  readonly session: GuestSession
  readonly control: SessionControl
  readonly supersededControllerId: string | null
  readonly room: RoomState | null
}

export interface ReconnectTarget {
  readonly sessionId: SessionId
  readonly roomId: RoomId | null
}

export interface SessionDisconnection {
  readonly disconnected: boolean
  readonly room: RoomState | null
}

export interface PublicLobby {
  readonly rooms: readonly LobbySummary[]
}

export interface RecipientLegalChoices {
  readonly handId: HandId
  readonly phaseId: PhaseId
  readonly gameRevision: Revision
  readonly choices: readonly LegalChoice[]
}

export interface GameActionInput {
  readonly roomId: RoomId
  readonly handId: HandId
  readonly phaseId: PhaseId
  readonly action: GameplayAction
}

export interface BotGameActionInput {
  readonly roomId: RoomId
  readonly seat: Seat
  readonly handId: HandId
  readonly phaseId: PhaseId
  readonly choiceId: ChoiceId
}
