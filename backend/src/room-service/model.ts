import type {
  CommandError,
  DisplayName,
  HandId,
  LobbySummary,
  ReadinessId,
  ReconnectCredential,
  Revision,
  RoomCode,
  RoomId,
  Seat,
  SessionId,
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
  | { readonly kind: 'playing'; readonly handId: HandId; readonly engineState: EngineState }
  | { readonly kind: 'between-hands'; readonly handId: HandId; readonly engineState: EngineState }

export interface RoomState {
  readonly roomId: RoomId
  readonly roomCode: RoomCode
  readonly visibility: Visibility
  readonly roomRevision: Revision
  readonly readinessId: ReadinessId
  readonly seats: FourRoomSeats
  readonly stage: RoomStage
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

export interface SessionDisconnection {
  readonly disconnected: boolean
  readonly room: RoomState | null
}

export interface PublicLobby {
  readonly rooms: readonly LobbySummary[]
}
