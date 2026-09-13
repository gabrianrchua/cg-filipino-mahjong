import type {
  FlowerTile,
  HandResult,
  MeldId,
  PlayerSafeTile,
  Seat,
  SuitedTile,
  TileId,
} from '@cg-filipino-mahjong/shared'

export type EngineTile = PlayerSafeTile

export type ThreeTileTuple = readonly [SuitedTile, SuitedTile, SuitedTile]
export type FourTileTuple = readonly [SuitedTile, SuitedTile, SuitedTile, SuitedTile]
export type TileIdPair = readonly [TileId, TileId]
export type TileIdTriple = readonly [TileId, TileId, TileId]
export type TileIdQuadruple = readonly [TileId, TileId, TileId, TileId]

export type DeclaredMeld =
  | { readonly meldId: MeldId; readonly kind: 'chow'; readonly tiles: ThreeTileTuple }
  | { readonly meldId: MeldId; readonly kind: 'pong'; readonly tiles: ThreeTileTuple }
  | { readonly meldId: MeldId; readonly kind: 'open-kang'; readonly tiles: FourTileTuple }
  | { readonly meldId: MeldId; readonly kind: 'secret'; readonly tiles: FourTileTuple }
  | { readonly meldId: MeldId; readonly kind: 'sagasa'; readonly tiles: FourTileTuple }

export interface SeatState {
  readonly seat: Seat
  readonly concealedTiles: readonly SuitedTile[]
  readonly melds: readonly DeclaredMeld[]
  readonly flowers: readonly FlowerTile[]
}

export type FourSeatStates = readonly [SeatState, SeatState, SeatState, SeatState]

export interface WallState {
  /** Front draws use index 0; back draws use the final index. */
  readonly remainingTiles: readonly EngineTile[]
}

export interface Discard {
  readonly tile: SuitedTile
  readonly discardedBy: Seat
  readonly status: 'pending' | 'dead'
}

export type DrawSource = 'dealer-opening' | 'front-wall' | 'gift'

export interface CurrentDraw {
  readonly seat: Seat
  readonly tileId: TileId
  readonly source: DrawSource
}

export type DiscardResponseChoice =
  | { readonly kind: 'pass' }
  | { readonly kind: 'win' }
  | { readonly kind: 'chow'; readonly concealedTileIds: TileIdPair }
  | { readonly kind: 'pong'; readonly concealedTileIds: TileIdPair }
  | { readonly kind: 'open-kang'; readonly concealedTileIds: TileIdTriple }

export interface SubmittedDiscardResponse {
  readonly seat: Seat
  readonly choice: DiscardResponseChoice
}

export type EnginePhase =
  | { readonly kind: 'setup' }
  | { readonly kind: 'player-action'; readonly actingSeat: Seat }
  | {
      readonly kind: 'discard-responses'
      readonly discarderSeat: Seat
      readonly discardTileId: TileId
      readonly responses: readonly SubmittedDiscardResponse[]
    }
  | { readonly kind: 'ended'; readonly result: HandResult }

export interface EngineState {
  /** The physical tiles participating in this hand. Production hands contain the canonical 144-tile set. */
  readonly tileUniverse: readonly EngineTile[]
  readonly dealerSeat: Seat
  readonly seats: FourSeatStates
  readonly wall: WallState
  readonly discards: readonly Discard[]
  readonly currentDraw: CurrentDraw | null
  readonly phase: EnginePhase
}

export type EngineAction =
  | { readonly kind: 'discard'; readonly seat: Seat; readonly tileId: TileId }
  | { readonly kind: 'win'; readonly seat: Seat }
  | { readonly kind: 'secret'; readonly seat: Seat; readonly concealedTileIds: TileIdQuadruple }
  | { readonly kind: 'sagasa'; readonly seat: Seat; readonly meldId: MeldId; readonly tileId: TileId }
  | { readonly kind: 'respond-to-discard'; readonly seat: Seat; readonly choice: DiscardResponseChoice }

export type EngineErrorCode =
  | 'invalid-action-for-phase'
  | 'invalid-dealer'
  | 'invalid-random-value'
  | 'invalid-state'
  | 'invalid-wall'
  | 'out-of-turn'

export interface EngineError {
  readonly code: EngineErrorCode
  readonly message: string
  readonly issues?: readonly InvariantIssue[]
}

export type EngineTransitionResult =
  | { readonly accepted: true; readonly state: EngineState }
  | { readonly accepted: false; readonly error: EngineError }

export interface InvariantIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}
