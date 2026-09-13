import { randomInt } from 'node:crypto'

import type {
  FlowerIdentity,
  FlowerTile,
  Rank,
  Seat,
  Suit,
  SuitedTile,
} from '@cg-filipino-mahjong/shared'

import type { EngineTile } from './model.js'

export interface RandomSource {
  nextInt(exclusiveMaximum: number): number
}

export const systemRandomSource: RandomSource = Object.freeze({
  nextInt: (exclusiveMaximum: number) => randomInt(exclusiveMaximum),
})

const SUITS = ['sticks', 'balls', 'characters'] as const satisfies readonly Suit[]
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const satisfies readonly Rank[]

const REPEATED_FLOWERS = [
  'east-wind',
  'south-wind',
  'west-wind',
  'north-wind',
  'red-dragon',
  'green-dragon',
  'white-dragon',
] as const satisfies readonly FlowerIdentity[]

const UNIQUE_FLOWERS = [
  'spring',
  'summer',
  'autumn',
  'winter',
  'plum',
  'orchid',
  'chrysanthemum',
  'bamboo',
] as const satisfies readonly FlowerIdentity[]

const copies = [1, 2, 3, 4] as const

const suitedTile = (suit: Suit, rank: Rank, copy: number): SuitedTile => Object.freeze({
  tileId: `suited-${suit}-${rank}-${copy}`,
  kind: 'suited',
  suit,
  rank,
})

const flowerTile = (identity: FlowerIdentity, copy: number): FlowerTile => Object.freeze({
  tileId: `flower-${identity}-${copy}`,
  kind: 'flower',
  identity,
})

export function createCanonicalTileSet(): readonly EngineTile[] {
  const tiles: EngineTile[] = []

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      for (const copy of copies) tiles.push(suitedTile(suit, rank, copy))
    }
  }

  for (const identity of REPEATED_FLOWERS) {
    for (const copy of copies) tiles.push(flowerTile(identity, copy))
  }

  for (const identity of UNIQUE_FLOWERS) tiles.push(flowerTile(identity, 1))

  return Object.freeze(tiles)
}

export function shuffleTiles(
  tiles: readonly EngineTile[],
  randomSource: RandomSource = systemRandomSource,
): readonly EngineTile[] {
  const shuffled = [...tiles]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomSource.nextInt(index + 1)
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new RangeError(`Random source returned ${swapIndex}; expected an integer from 0 through ${index}`)
    }
    const current = shuffled[index]
    shuffled[index] = shuffled[swapIndex]!
    shuffled[swapIndex] = current!
  }
  return Object.freeze(shuffled)
}

export function chooseDealer(randomSource: RandomSource = systemRandomSource): Seat {
  const seat = randomSource.nextInt(4)
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
    throw new RangeError(`Random source returned ${seat}; expected a seat from 0 through 3`)
  }
  return seat as Seat
}

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat
}
