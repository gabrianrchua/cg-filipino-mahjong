import type { SuitedTile } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  HAND_ORDER_STORAGE_KEY,
  moveTile,
  persistHandOrder,
  readPersistedHandOrder,
  sortedTileIds,
} from './handArrangement.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const tile = (tileId: string, suit: SuitedTile['suit'], rank: number): SuitedTile => ({
  tileId, kind: 'suited', suit, rank,
})

describe('hand arrangement helpers', () => {
  it('sorts by canonical suit, rank, and physical tile ID', () => {
    expect(sortedTileIds([
      tile('characters-1-a', 'characters', 1),
      tile('sticks-2-a', 'sticks', 2),
      tile('balls-1-a', 'balls', 1),
      tile('sticks-1-b', 'sticks', 1),
      tile('sticks-1-a', 'sticks', 1),
    ])).toEqual(['sticks-1-a', 'sticks-1-b', 'sticks-2-a', 'balls-1-a', 'characters-1-a'])
  })

  it('moves a physical tile one slot without crossing an endpoint', () => {
    const order = ['a', 'b', 'c']
    expect(moveTile(order, 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveTile(order, 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveTile(order, 'a', -1)).toBe(order)
    expect(moveTile(order, 'missing', 1)).toBe(order)
  })

  it('round-trips a valid record and removes malformed or duplicate IDs', () => {
    const storage = new MemoryStorage()
    expect(persistHandOrder(storage, { identity: 'room:hand:0', tileOrder: ['a', 'b'] })).toBe(true)
    expect(readPersistedHandOrder(storage)).toEqual({ identity: 'room:hand:0', tileOrder: ['a', 'b'] })

    storage.setItem(HAND_ORDER_STORAGE_KEY, JSON.stringify({ identity: 'room:hand:0', tileOrder: ['a', 'a'] }))
    expect(readPersistedHandOrder(storage)).toBeNull()
    expect(storage.getItem(HAND_ORDER_STORAGE_KEY)).toBeNull()
  })
})
