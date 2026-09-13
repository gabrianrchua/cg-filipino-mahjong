import type { Seat, SuitedTile, TileId } from '@cg-filipino-mahjong/shared'

import type {
  EngineAction,
  EngineState,
  TileIdQuadruple,
} from './model.js'

function sameFace(left: SuitedTile, right: SuitedTile): boolean {
  return left.suit === right.suit && left.rank === right.rank
}

function selectedConcealedTiles(
  state: EngineState,
  seat: Seat,
  tileIds: readonly TileId[],
): readonly SuitedTile[] | null {
  if (new Set(tileIds).size !== tileIds.length) return null
  const concealed = state.seats[seat]?.concealedTiles
  if (!concealed) return null
  const tiles = tileIds.map((tileId) => concealed.find((tile) => tile.tileId === tileId))
  return tiles.every((tile): tile is SuitedTile => tile !== undefined) ? tiles : null
}

export function validateSecretAction(
  state: EngineState,
  action: Extract<EngineAction, { kind: 'secret' }>,
): string | null {
  if (action.concealedTileIds.length !== 4) return 'A secret requires exactly four concealed tiles.'
  const tiles = selectedConcealedTiles(state, action.seat, action.concealedTileIds)
  if (!tiles) return 'A secret must select four distinct suited tiles in the acting seat\'s concealed hand.'
  return tiles.every((tile) => sameFace(tile, tiles[0]!))
    ? null
    : 'The selected tiles do not form a concealed four-of-a-kind.'
}

export function validateSagasaAction(
  state: EngineState,
  action: Extract<EngineAction, { kind: 'sagasa' }>,
): string | null {
  const owner = state.seats[action.seat]
  const meld = owner?.melds.find((candidate) => candidate.meldId === action.meldId)
  if (!owner || !meld || meld.kind !== 'pong') {
    return 'Sagasa must upgrade an existing open pong owned by the acting seat.'
  }

  const draw = state.currentDraw
  if (draw?.seat !== action.seat || draw.tileId !== action.tileId) {
    return 'Sagasa must use the acting seat\'s current drawn tile.'
  }
  const tile = owner.concealedTiles.find((candidate) => candidate.tileId === action.tileId)
  if (!tile) return 'The current drawn tile is not in the acting seat\'s concealed hand.'
  return sameFace(tile, meld.tiles[0]!)
    ? null
    : 'The current drawn tile does not match the open pong.'
}

export function getSpecialMeldActions(state: EngineState, seat: Seat): readonly EngineAction[] {
  const owner = state.seats[seat]
  if (!owner) return Object.freeze([])

  const actions: EngineAction[] = []
  const faces = new Map<string, SuitedTile[]>()
  for (const tile of owner.concealedTiles) {
    const key = `${tile.suit}:${tile.rank}`
    const matching = faces.get(key) ?? []
    matching.push(tile)
    faces.set(key, matching)
  }
  for (const matching of faces.values()) {
    if (matching.length === 4) {
      actions.push({
        kind: 'secret',
        seat,
        concealedTileIds: matching.map((tile) => tile.tileId) as unknown as TileIdQuadruple,
      })
    }
  }

  const drawnTile = state.currentDraw?.seat === seat
    ? owner.concealedTiles.find((tile) => tile.tileId === state.currentDraw?.tileId)
    : undefined
  if (drawnTile) {
    for (const meld of owner.melds) {
      if (meld.kind === 'pong' && sameFace(drawnTile, meld.tiles[0]!)) {
        actions.push({
          kind: 'sagasa',
          seat,
          meldId: meld.meldId,
          tileId: drawnTile.tileId,
        })
      }
    }
  }

  return Object.freeze(actions)
}
