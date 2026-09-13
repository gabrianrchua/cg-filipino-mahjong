import type { Seat, SuitedTile } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  createCanonicalTileSet,
  initializeHand,
  nextSeat,
  shuffleTiles,
  validateActionForPhase,
  validateEngineState,
  type DeclaredMeld,
  type EngineState,
  type FourSeatStates,
  type RandomSource,
  type SeatState,
} from './index.js'

const meldId = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

function seededRandom(seed: number): RandomSource {
  let value = seed >>> 0
  return {
    nextInt(exclusiveMaximum) {
      value = ((value * 1_664_525) + 1_013_904_223) >>> 0
      return value % exclusiveMaximum
    },
  }
}

function acceptedInitialState(): EngineState {
  const result = initializeHand({ randomSource: seededRandom(42) })
  if (!result.accepted) throw new Error(result.error.message)
  return result.state
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function takeSuited(
  pool: ReturnType<typeof createCanonicalTileSet>[number][],
  count: number,
  predicate: (tile: SuitedTile) => boolean = () => true,
): SuitedTile[] {
  const selected: SuitedTile[] = []
  for (let index = 0; index < pool.length && selected.length < count;) {
    const tile = pool[index]
    if (tile?.kind === 'suited' && predicate(tile)) {
      selected.push(tile)
      pool.splice(index, 1)
    } else {
      index += 1
    }
  }
  if (selected.length !== count) throw new Error(`Could not select ${count} suited tiles`)
  return selected
}

function actionStateWithFourTileMeld(): EngineState {
  const pool = [...createCanonicalTileSet()]
  const chowTiles = [1, 2, 3].map((rank) => takeSuited(
    pool,
    1,
    (tile) => tile.suit === 'sticks' && tile.rank === rank,
  )[0]!) as [SuitedTile, SuitedTile, SuitedTile]
  const secretTiles = takeSuited(
    pool,
    4,
    (tile) => tile.suit === 'dots' && tile.rank === 5,
  ) as [SuitedTile, SuitedTile, SuitedTile, SuitedTile]
  const melds: readonly DeclaredMeld[] = [
    { meldId: meldId(1), kind: 'chow', tiles: chowTiles },
    { meldId: meldId(2), kind: 'secret', tiles: secretTiles },
  ]
  const states: SeatState[] = ([0, 1, 2, 3] as const).map((seat) => ({
    seat,
    concealedTiles: takeSuited(pool, seat === 0 ? 11 : 16),
    melds: seat === 0 ? melds : [],
    flowers: [],
  }))

  return {
    dealerSeat: 0,
    seats: states as unknown as FourSeatStates,
    wall: { remainingTiles: pool },
    discards: [],
    currentDraw: null,
    phase: { kind: 'player-action', actingSeat: 0 },
  }
}

function responseState(): EngineState {
  const actionState = actionStateWithFourTileMeld()
  const discardedTile = actionState.seats[0].concealedTiles[0]!
  const seats = actionState.seats.map((seat) => seat.seat === 0
    ? { ...seat, concealedTiles: seat.concealedTiles.slice(1) }
    : seat) as unknown as FourSeatStates
  return {
    ...actionState,
    seats,
    discards: [{ tile: discardedTile, discardedBy: 0, status: 'pending' }],
    phase: { kind: 'discard-responses', discarderSeat: 0, discardTileId: discardedTile.tileId, responses: [] },
  }
}

describe('canonical physical tiles', () => {
  it('creates the exact 144-tile set with stable unique IDs', () => {
    const tiles = createCanonicalTileSet()
    const suited = tiles.filter((tile) => tile.kind === 'suited')
    const flowers = tiles.filter((tile) => tile.kind === 'flower')

    expect(tiles).toHaveLength(144)
    expect(new Set(tiles.map((tile) => tile.tileId)).size).toBe(144)
    expect(suited).toHaveLength(108)
    expect(flowers).toHaveLength(36)
    for (const suit of ['sticks', 'dots', 'characters'] as const) {
      for (let rank = 1; rank <= 9; rank += 1) {
        expect(suited.filter((tile) => tile.suit === suit && tile.rank === rank)).toHaveLength(4)
      }
    }
    for (const identity of ['east-wind', 'south-wind', 'west-wind', 'north-wind', 'red-dragon', 'green-dragon', 'white-dragon']) {
      expect(flowers.filter((tile) => tile.identity === identity)).toHaveLength(4)
    }
    for (const identity of ['spring', 'summer', 'autumn', 'winter', 'plum', 'orchid', 'chrysanthemum', 'bamboo']) {
      expect(flowers.filter((tile) => tile.identity === identity)).toHaveLength(1)
    }
  })

  it('shuffles reproducibly without changing its input', () => {
    const tiles = createCanonicalTileSet()
    const originalOrder = tiles.map((tile) => tile.tileId)
    const first = shuffleTiles(tiles, seededRandom(7)).map((tile) => tile.tileId)
    const second = shuffleTiles(tiles, seededRandom(7)).map((tile) => tile.tileId)

    expect(first).toEqual(second)
    expect(first).not.toEqual(originalOrder)
    expect(tiles.map((tile) => tile.tileId)).toEqual(originalOrder)
  })

  it('uses counterclockwise seat progression', () => {
    expect(([0, 1, 2, 3] as Seat[]).map(nextSeat)).toEqual([1, 2, 3, 0])
  })
})

describe('hand initialization', () => {
  it('reproduces dealer and wall with injected randomness', () => {
    const first = initializeHand({ randomSource: seededRandom(99) })
    const second = initializeHand({ randomSource: seededRandom(99) })

    expect(first).toEqual(second)
    expect(first.accepted && first.state.phase.kind).toBe('setup')
    expect(first.accepted && first.state.wall.remainingTiles).toHaveLength(144)
  })

  it('accepts explicit dealer and wall fixtures without consuming randomness', () => {
    const wall = [...createCanonicalTileSet()].reverse()
    const randomSource: RandomSource = { nextInt: () => { throw new Error('must not be called') } }
    const result = initializeHand({ dealerSeat: 3, wall, randomSource })

    expect(result.accepted).toBe(true)
    expect(result.accepted && result.state.dealerSeat).toBe(3)
    expect(result.accepted && result.state.wall.remainingTiles.map((tile) => tile.tileId))
      .toEqual(wall.map((tile) => tile.tileId))
  })

  it('rejects a non-conserving wall without mutating the fixture', () => {
    const wall = [...createCanonicalTileSet()]
    wall[143] = wall[0]!
    const before = wall.map((tile) => tile.tileId)
    deepFreeze(wall)
    const result = initializeHand({ dealerSeat: 0, wall })

    expect(result).toMatchObject({ accepted: false, error: { code: 'invalid-wall' } })
    expect(wall.map((tile) => tile.tileId)).toEqual(before)
  })

  it('returns a structured error for an invalid random source', () => {
    const result = initializeHand({ randomSource: { nextInt: () => -1 } })
    expect(result).toMatchObject({ accepted: false, error: { code: 'invalid-random-value' } })
  })
})

describe('engine invariants', () => {
  it('accepts setup and a legal action hand containing a four-tile meld', () => {
    const setup = acceptedInitialState()
    const action = actionStateWithFourTileMeld()
    const actingSeat = action.seats[0]

    expect(validateEngineState(setup)).toEqual([])
    expect(validateEngineState(action)).toEqual([])
    expect(actingSeat.concealedTiles.length).toBe(11)
    expect(actingSeat.concealedTiles.length + actingSeat.melds.flatMap((meld) => meld.tiles).length).toBe(18)
  })

  it('finds missing, duplicated, misplaced, and structurally invalid tiles', () => {
    const setup = acceptedInitialState()
    const shortened: EngineState = {
      ...setup,
      wall: { remainingTiles: setup.wall.remainingTiles.slice(1) },
    }
    const duplicated: EngineState = {
      ...setup,
      wall: { remainingTiles: [...setup.wall.remainingTiles, setup.wall.remainingTiles[0]!] },
    }
    const action = actionStateWithFourTileMeld()
    const badMeldState: EngineState = {
      ...action,
      seats: action.seats.map((seat) => seat.seat === 0
        ? { ...seat, melds: [{ ...seat.melds[0]!, kind: 'pong' as const }, seat.melds[1]!] }
        : seat) as unknown as FourSeatStates,
    }

    expect(validateEngineState(shortened).map((entry) => entry.code)).toContain('missing-tile')
    expect(validateEngineState(duplicated).map((entry) => entry.code)).toContain('duplicate-tile')
    expect(validateEngineState(badMeldState).map((entry) => entry.code)).toContain('invalid-matching-meld')

    const flower = setup.wall.remainingTiles.find((tile) => tile.kind === 'flower')!
    const wrongZone: EngineState = {
      ...setup,
      wall: { remainingTiles: setup.wall.remainingTiles.filter((tile) => tile.tileId !== flower.tileId) },
      seats: [{ ...setup.seats[0], concealedTiles: [flower as unknown as SuitedTile] }, ...setup.seats.slice(1)] as unknown as FourSeatStates,
    }
    expect(validateEngineState(wrongZone).map((entry) => entry.code)).toContain('tile-in-wrong-zone')
  })

  it('enforces concealed counts including the extra physical káng tile', () => {
    const action = actionStateWithFourTileMeld()
    const moved = action.seats[0].concealedTiles[0]!
    const invalid: EngineState = {
      ...action,
      seats: action.seats.map((seat) => seat.seat === 0
        ? { ...seat, concealedTiles: seat.concealedTiles.slice(1) }
        : seat) as unknown as FourSeatStates,
      wall: { remainingTiles: [...action.wall.remainingTiles, moved] },
    }
    expect(validateEngineState(invalid).map((entry) => entry.code)).toContain('invalid-concealed-count')
  })

  it('requires a response phase to reference exactly one pending discard', () => {
    const valid = responseState()
    expect(validateEngineState(valid)).toEqual([])
    expect(validateEngineState({ ...valid, discards: [] }).map((entry) => entry.code))
      .toContain('inconsistent-pending-discard')
    expect(validateEngineState({ ...valid, phase: { kind: 'player-action', actingSeat: 1 } }).map((entry) => entry.code))
      .toContain('pending-discard-outside-response-phase')
  })
})

describe('phase action compatibility', () => {
  it('accepts only the acting seat during a player-action phase', () => {
    const state = deepFreeze(actionStateWithFourTileMeld())
    const before = JSON.stringify(state)

    expect(validateActionForPhase(state, { kind: 'discard', seat: 0, tileId: state.seats[0].concealedTiles[0]!.tileId }))
      .toMatchObject({ accepted: true })
    expect(validateActionForPhase(state, { kind: 'discard', seat: 1, tileId: state.seats[1].concealedTiles[0]!.tileId }))
      .toMatchObject({ accepted: false, error: { code: 'out-of-turn' } })
    expect(validateActionForPhase(state, { kind: 'respond-to-discard', seat: 1, choice: { kind: 'pass' } }))
      .toMatchObject({ accepted: false, error: { code: 'invalid-action-for-phase' } })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('allows each opponent one private final response', () => {
    const state = responseState()
    expect(validateActionForPhase(state, { kind: 'respond-to-discard', seat: 1, choice: { kind: 'pass' } }))
      .toMatchObject({ accepted: true })
    expect(validateActionForPhase(state, { kind: 'discard', seat: 1, tileId: state.seats[1].concealedTiles[0]!.tileId }))
      .toMatchObject({ accepted: false, error: { code: 'invalid-action-for-phase' } })
    expect(validateActionForPhase(state, { kind: 'respond-to-discard', seat: 0, choice: { kind: 'pass' } }))
      .toMatchObject({ accepted: false, error: { code: 'out-of-turn' } })

    const responded: EngineState = {
      ...state,
      phase: { ...state.phase as Extract<EngineState['phase'], { kind: 'discard-responses' }>, responses: [{ seat: 1, choice: { kind: 'pass' } }] },
    }
    expect(validateActionForPhase(responded, { kind: 'respond-to-discard', seat: 1, choice: { kind: 'win' } }))
      .toMatchObject({ accepted: false, error: { code: 'out-of-turn' } })
  })

  it('rejects actions against setup without mutating the input', () => {
    const state = deepFreeze(acceptedInitialState())
    const before = JSON.stringify(state)
    const result = validateActionForPhase(state, { kind: 'win', seat: 0 })

    expect(result).toMatchObject({ accepted: false, error: { code: 'invalid-action-for-phase' } })
    expect(JSON.stringify(state)).toBe(before)
  })
})
