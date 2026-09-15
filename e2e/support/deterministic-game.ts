import type { SuitedTile } from '@cg-filipino-mahjong/shared'

import {
  createCanonicalTileSet,
  validateEngineState,
  type DeclaredMeld,
  type EngineState,
  type EngineTransitionResult,
  type FourSeatStates,
  type SeatState,
} from '../../backend/src/game-engine/index.js'

type Face = readonly [SuitedTile['suit'], number, number]

function takeFaces(pool: ReturnType<typeof createCanonicalTileSet>[number][], faces: readonly Face[]): SuitedTile[] {
  const result: SuitedTile[] = []
  for (const [suit, rank, count] of faces) {
    for (let copy = 0; copy < count; copy += 1) {
      const index = pool.findIndex((tile) => tile.kind === 'suited' && tile.suit === suit && tile.rank === rank)
      const tile = pool[index]
      if (index < 0 || tile?.kind !== 'suited') throw new Error(`Missing fixture tile ${suit} ${rank}.`)
      result.push(tile)
      pool.splice(index, 1)
    }
  }
  return result
}

function fillSuited(pool: ReturnType<typeof createCanonicalTileSet>[number][], tiles: SuitedTile[], count: number): SuitedTile[] {
  while (tiles.length < count) {
    const index = pool.findIndex((tile) => tile.kind === 'suited')
    const tile = pool[index]
    if (index < 0 || tile?.kind !== 'suited') throw new Error('Not enough suited fixture tiles.')
    tiles.push(tile)
    pool.splice(index, 1)
  }
  return tiles
}

function accepted(state: EngineState): EngineTransitionResult {
  const issues = validateEngineState(state)
  if (issues.length > 0) throw new Error(`Invalid E2E fixture: ${JSON.stringify(issues)}`)
  return { accepted: true, state }
}

/**
 * Seat zero can discard characters nine. Seats one and three can both win on it,
 * while seat two owns a declared secret that must remain masked to everyone else.
 */
export function createCompetingClaimsHand(): EngineTransitionResult {
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const discard = takeFaces(pool, [['characters', 9, 1]])[0]!
  const seatOne = takeFaces(pool, [
    ['sticks', 1, 3], ['sticks', 2, 3], ['sticks', 3, 3],
    ['sticks', 4, 3], ['sticks', 5, 3], ['characters', 9, 1],
  ])
  const seatThree = takeFaces(pool, [
    ['balls', 1, 3], ['balls', 2, 3], ['balls', 3, 3],
    ['balls', 4, 3], ['balls', 5, 3], ['characters', 9, 1],
  ])
  const secretTiles = takeFaces(pool, [['characters', 8, 4]]) as [SuitedTile, SuitedTile, SuitedTile, SuitedTile]
  const secret: DeclaredMeld = {
    meldId: '90000000-0000-4000-8000-000000000001',
    kind: 'secret',
    tiles: secretTiles,
  }
  const seatZero = fillSuited(pool, [], 16)
  const seatTwo = fillSuited(pool, [], 13)
  const seats: FourSeatStates = [
    { seat: 0, concealedTiles: [...seatZero, discard], melds: [], flowers: [] },
    { seat: 1, concealedTiles: seatOne, melds: [], flowers: [] },
    { seat: 2, concealedTiles: seatTwo, melds: [secret], flowers: [] },
    { seat: 3, concealedTiles: seatThree, melds: [], flowers: [] },
  ]
  return accepted({
    tileUniverse,
    dealerSeat: 0,
    seats,
    wall: { remainingTiles: pool },
    discards: [],
    currentDraw: { seat: 0, tileId: discard.tileId, source: 'dealer-opening' },
    phase: { kind: 'player-action', actingSeat: 0 },
  })
}

const winningFaces: readonly Face[] = [
  ['sticks', 1, 3], ['sticks', 2, 3], ['sticks', 3, 3],
  ['characters', 4, 3], ['characters', 6, 3], ['characters', 7, 2],
]

/** The next dealer begins with a legal explicit self-draw win. */
export function createNextHand(previous: EngineState): EngineTransitionResult {
  if (previous.phase.kind !== 'ended') throw new Error('The E2E next-hand fixture requires an ended hand.')
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const dealerSeat = previous.phase.result.nextDealerSeat
  const winnerTiles = takeFaces(pool, winningFaces)
  const winningTile = winnerTiles.at(-1)!
  const seats = ([0, 1, 2, 3] as const).map((seat): SeatState => ({
    seat,
    concealedTiles: seat === dealerSeat ? winnerTiles : fillSuited(pool, [], 16),
    melds: [],
    flowers: [],
  })) as unknown as FourSeatStates
  return accepted({
    tileUniverse,
    dealerSeat,
    seats,
    wall: { remainingTiles: pool },
    discards: [],
    currentDraw: { seat: dealerSeat, tileId: winningTile.tileId, source: 'dealer-opening' },
    phase: { kind: 'player-action', actingSeat: dealerSeat },
  })
}
