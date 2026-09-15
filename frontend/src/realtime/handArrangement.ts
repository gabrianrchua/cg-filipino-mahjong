import { TileIdSchema, type SuitedTile, type TileId } from '@cg-filipino-mahjong/shared'

export const HAND_ORDER_STORAGE_KEY = 'cg-filipino-mahjong.handOrder.v1'

export interface PersistedHandOrder {
  readonly identity: string
  readonly tileOrder: readonly TileId[]
}

type HandOrderStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const SUIT_ORDER = { sticks: 0, balls: 1, characters: 2 } as const

export function compareHandTiles(left: SuitedTile, right: SuitedTile): number {
  return SUIT_ORDER[left.suit] - SUIT_ORDER[right.suit]
    || left.rank - right.rank
    || left.tileId.localeCompare(right.tileId)
}

export function sortedTileIds(tiles: readonly SuitedTile[]): readonly TileId[] {
  return [...tiles].sort(compareHandTiles).map((tile) => tile.tileId)
}

export function moveTile(
  tileOrder: readonly TileId[],
  tileId: TileId,
  direction: -1 | 1,
): readonly TileId[] {
  const from = tileOrder.indexOf(tileId)
  if (from < 0) return tileOrder
  const to = from + direction
  if (to < 0 || to >= tileOrder.length) return tileOrder
  const next = [...tileOrder]
  ;[next[from], next[to]] = [next[to]!, next[from]!]
  return next
}

export function readPersistedHandOrder(storage: HandOrderStorage | undefined): PersistedHandOrder | null {
  if (!storage) return null
  try {
    const stored = storage.getItem(HAND_ORDER_STORAGE_KEY)
    if (stored === null) return null
    const value: unknown = JSON.parse(stored)
    if (!value || typeof value !== 'object') throw new Error('Invalid hand order')
    const identity = 'identity' in value ? value.identity : null
    const tileOrder = 'tileOrder' in value ? value.tileOrder : null
    if (
      typeof identity !== 'string'
      || identity.length === 0
      || !Array.isArray(tileOrder)
      || tileOrder.some((tileId) => !TileIdSchema.safeParse(tileId).success)
      || new Set(tileOrder).size !== tileOrder.length
    ) throw new Error('Invalid hand order')
    return { identity, tileOrder: tileOrder as TileId[] }
  } catch {
    try {
      storage.removeItem(HAND_ORDER_STORAGE_KEY)
    } catch {
      // Browser privacy settings can make storage unavailable at any time.
    }
    return null
  }
}

export function persistHandOrder(storage: HandOrderStorage | undefined, hand: PersistedHandOrder): boolean {
  if (!storage) return false
  try {
    storage.setItem(HAND_ORDER_STORAGE_KEY, JSON.stringify(hand))
    return true
  } catch {
    return false
  }
}
