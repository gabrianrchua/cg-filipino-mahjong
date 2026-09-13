import type { Seat, SuitedTile } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  applyEngineAction,
  createCanonicalTileSet,
  getLegalActions,
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
import { acquireTile } from './draws.js'

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

function setupState(wall = createCanonicalTileSet()): EngineState {
  return {
    tileUniverse: wall,
    dealerSeat: 0,
    seats: ([0, 1, 2, 3] as const).map((seat) => ({
      seat,
      concealedTiles: [],
      melds: [],
      flowers: [],
    })) as unknown as FourSeatStates,
    wall: { remainingTiles: wall },
    discards: [],
    currentDraw: null,
    phase: { kind: 'setup' },
  }
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
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const chowTiles = [1, 2, 3].map((rank) => takeSuited(
    pool,
    1,
    (tile) => tile.suit === 'sticks' && tile.rank === rank,
  )[0]!) as [SuitedTile, SuitedTile, SuitedTile]
  const secretTiles = takeSuited(
    pool,
    4,
    (tile) => tile.suit === 'balls' && tile.rank === 5,
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
    tileUniverse,
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
    for (const suit of ['sticks', 'balls', 'characters'] as const) {
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
    expect(first.accepted && first.state.phase).toEqual({
      kind: 'player-action',
      actingSeat: first.accepted ? first.state.dealerSeat : 0,
    })
    expect(first.accepted && first.state.seats.map((seat) => seat.concealedTiles.length).sort((a, b) => a - b))
      .toEqual([16, 16, 16, 17])
    expect(first.accepted && validateEngineState(first.state)).toEqual([])
  })

  it('accepts explicit dealer and wall fixtures without consuming randomness', () => {
    const wall = [...createCanonicalTileSet()].reverse()
    const before = wall.map((tile) => tile.tileId)
    const randomSource: RandomSource = { nextInt: () => { throw new Error('must not be called') } }
    const result = initializeHand({ dealerSeat: 3, wall, randomSource })

    expect(result.accepted).toBe(true)
    expect(result.accepted && result.state.dealerSeat).toBe(3)
    expect(result.accepted && result.state.tileUniverse.map((tile) => tile.tileId))
      .toEqual(wall.map((tile) => tile.tileId))
    expect(wall.map((tile) => tile.tileId)).toEqual(before)
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

  it('rejects unknown and identity-mismatched fixture tiles', () => {
    const suited = createCanonicalTileSet().find((tile) => tile.kind === 'suited')!
    const unknown = { ...suited, tileId: 'unknown-suited-tile' }
    const mismatched = { ...suited, rank: suited.rank === 9 ? 8 : suited.rank + 1 } as SuitedTile

    expect(initializeHand({ dealerSeat: 0, wall: [unknown] }))
      .toMatchObject({ accepted: false, error: { code: 'invalid-wall' } })
    expect(initializeHand({ dealerSeat: 0, wall: [mismatched] }))
      .toMatchObject({ accepted: false, error: { code: 'invalid-wall' } })
  })

  it('returns a structured error for an invalid random source', () => {
    const result = initializeHand({ randomSource: { nextInt: () => -1 } })
    expect(result).toMatchObject({ accepted: false, error: { code: 'invalid-random-value' } })
  })

  it('deals two eight-tile rounds counterclockwise, then the dealer opening tile', () => {
    const wall = createCanonicalTileSet().filter((tile) => tile.kind === 'suited').slice(0, 65)
    const result = initializeHand({ dealerSeat: 2, wall })
    if (!result.accepted) throw new Error(result.error.message)

    expect(result.state.seats[2].concealedTiles.map((tile) => tile.tileId)).toEqual([
      ...wall.slice(0, 8),
      ...wall.slice(32, 40),
      wall[64],
    ].map((tile) => tile?.tileId))
    expect(result.state.seats[3].concealedTiles.map((tile) => tile.tileId))
      .toEqual([...wall.slice(8, 16), ...wall.slice(40, 48)].map((tile) => tile.tileId))
    expect(result.state.seats[0].concealedTiles.map((tile) => tile.tileId))
      .toEqual([...wall.slice(16, 24), ...wall.slice(48, 56)].map((tile) => tile.tileId))
    expect(result.state.seats[1].concealedTiles.map((tile) => tile.tileId))
      .toEqual([...wall.slice(24, 32), ...wall.slice(56, 64)].map((tile) => tile.tileId))
    expect(result.state.currentDraw).toEqual({ seat: 2, tileId: wall[64]?.tileId, source: 'dealer-opening' })
    expect(result.state.wall.remainingTiles).toEqual([])
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('replaces initial flowers by seat and receipt order, preserving opening provenance', () => {
    const canonical = createCanonicalTileSet()
    const suited = canonical.filter((tile) => tile.kind === 'suited').slice(0, 65)
    const flowers = canonical.filter((tile) => tile.kind === 'flower').slice(0, 4)
    const front: (typeof canonical)[number][] = suited.slice(0, 62)
    front.splice(0, 0, flowers[0]!)
    front.splice(8, 0, flowers[1]!)
    front.push(flowers[2]!)
    const wall = [...front, suited[64]!, suited[63]!, suited[62]!, flowers[3]!]
    const result = initializeHand({ dealerSeat: 0, wall })
    if (!result.accepted) throw new Error(result.error.message)

    expect(result.state.seats[0].flowers.map((tile) => tile.tileId))
      .toEqual([flowers[0]!.tileId, flowers[2]!.tileId, flowers[3]!.tileId])
    expect(result.state.seats[1].flowers.map((tile) => tile.tileId)).toEqual([flowers[1]!.tileId])
    expect(result.state.currentDraw).toEqual({ seat: 0, tileId: suited[63]!.tileId, source: 'dealer-opening' })
    expect(result.state.seats[0].concealedTiles.at(-1)?.tileId).toBe(suited[63]!.tileId)
    expect(result.state.seats[1].concealedTiles.at(-1)?.tileId).toBe(suited[64]!.tileId)
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('ends in an inspectable draw when a short fixture exhausts during dealing or replacement', () => {
    const canonical = createCanonicalTileSet()
    const suited = canonical.filter((tile) => tile.kind === 'suited')
    const flower = canonical.find((tile) => tile.kind === 'flower')!
    const duringDeal = initializeHand({ dealerSeat: 3, wall: suited.slice(0, 10) })
    const duringReplacement = initializeHand({ dealerSeat: 3, wall: [flower, ...suited.slice(0, 64)] })

    for (const result of [duringDeal, duringReplacement]) {
      if (!result.accepted) throw new Error(result.error.message)
      expect(result.state.phase).toEqual({
        kind: 'ended',
        result: { kind: 'exhaustion-draw', nextDealerSeat: 0 },
      })
      expect(result.state.wall.remainingTiles).toEqual([])
      expect(result.state.currentDraw).toBeNull()
      expect(validateEngineState(result.state)).toEqual([])
    }
    expect(duringReplacement.accepted && duringReplacement.state.seats[3].flowers).toEqual([flower])
  })
})

describe('automatic wall acquisitions', () => {
  it('draws from the front, exposes a flower, and replaces it from the back', () => {
    const canonical = createCanonicalTileSet()
    const frontFlower = canonical.find((tile) => tile.kind === 'flower')!
    const suited = canonical.filter((tile) => tile.kind === 'suited').slice(0, 2)
    const input = deepFreeze(setupState([frontFlower, suited[0]!, suited[1]!]))
    const before = JSON.stringify(input)
    const result = acquireTile(input, 1, 'front-wall')

    expect(result.tile).toEqual(suited[1])
    expect(result.state.wall.remainingTiles).toEqual([suited[0]])
    expect(result.state.seats[1].flowers).toEqual([frontFlower])
    expect(result.state.currentDraw).toEqual({ seat: 1, tileId: suited[1]!.tileId, source: 'front-wall' })
    expect(validateEngineState(result.state)).toEqual([])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('takes gifts and their chained flower replacements only from the back', () => {
    const canonical = createCanonicalTileSet()
    const flowers = canonical.filter((tile) => tile.kind === 'flower').slice(0, 2)
    const suited = canonical.filter((tile) => tile.kind === 'suited').slice(0, 2)
    const input = setupState([suited[0]!, suited[1]!, flowers[1]!, flowers[0]!])
    const result = acquireTile(input, 2, 'gift')

    expect(result.tile).toEqual(suited[1])
    expect(result.state.wall.remainingTiles).toEqual([suited[0]])
    expect(result.state.seats[2].flowers).toEqual(flowers)
    expect(result.state.currentDraw).toEqual({ seat: 2, tileId: suited[1]!.tileId, source: 'gift' })
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('ends the hand when either end or a flower replacement cannot supply a tile', () => {
    const flower = createCanonicalTileSet().find((tile) => tile.kind === 'flower')!
    const emptyFront = acquireTile(setupState([]), 0, 'front-wall')
    const emptyBack = acquireTile(setupState([]), 0, 'gift')
    const afterFlower = acquireTile(setupState([flower]), 0, 'front-wall')

    for (const result of [emptyFront, emptyBack, afterFlower]) {
      expect(result.tile).toBeNull()
      expect(result.state.phase).toEqual({
        kind: 'ended',
        result: { kind: 'exhaustion-draw', nextDealerSeat: 1 },
      })
      expect(validateEngineState(result.state)).toEqual([])
    }
    expect(afterFlower.state.seats[0].flowers).toEqual([flower])
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
    const state = deepFreeze(setupState())
    const before = JSON.stringify(state)
    const result = validateActionForPhase(state, { kind: 'win', seat: 0 })

    expect(result).toMatchObject({ accepted: false, error: { code: 'invalid-action-for-phase' } })
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('ordinary turns and legal actions', () => {
  it('offers every concealed discard to only the acting seat', () => {
    const state = acceptedInitialState()
    if (state.phase.kind !== 'player-action') throw new Error('Expected player action')
    const dealer = state.phase.actingSeat
    const legalActions = getLegalActions(state, dealer)

    expect(legalActions).toEqual(state.seats[dealer].concealedTiles.map((tile) => ({
      kind: 'discard',
      seat: dealer,
      tileId: tile.tileId,
    })))
    expect(legalActions).toHaveLength(17)
    for (const seat of ([0, 1, 2, 3] as const).filter((seat) => seat !== dealer)) {
      expect(getLegalActions(state, seat)).toEqual([])
    }
    for (const action of legalActions) {
      expect(applyEngineAction(state, action)).toMatchObject({ accepted: true })
    }
  })

  it('moves a discard into its own response phase and clears draw provenance', () => {
    const state = deepFreeze(acceptedInitialState())
    if (state.phase.kind !== 'player-action') throw new Error('Expected player action')
    const before = JSON.stringify(state)
    const action = getLegalActions(state, state.phase.actingSeat)[0]!
    const result = applyEngineAction(state, action)
    if (!result.accepted || action.kind !== 'discard') throw new Error('Expected accepted discard')

    expect(result.state.phase).toEqual({
      kind: 'discard-responses',
      discarderSeat: action.seat,
      discardTileId: action.tileId,
      responses: [],
    })
    expect(result.state.discards.at(-1)).toEqual({
      tile: state.seats[action.seat].concealedTiles.find((tile) => tile.tileId === action.tileId),
      discardedBy: action.seat,
      status: 'pending',
    })
    expect(result.state.currentDraw).toBeNull()
    expect(validateEngineState(result.state)).toEqual([])
    expect(JSON.stringify(state)).toBe(before)
  })

  it('collects three passes, kills the discard, and advances counterclockwise with a front draw', () => {
    const initial = acceptedInitialState()
    if (initial.phase.kind !== 'player-action') throw new Error('Expected player action')
    const discarder = initial.phase.actingSeat
    const discard = getLegalActions(initial, discarder)[0]!
    const discarded = applyEngineAction(initial, discard)
    if (!discarded.accepted || discarded.state.phase.kind !== 'discard-responses') {
      throw new Error('Expected discard responses')
    }

    let state = discarded.state
    const responders = [nextSeat(nextSeat(discarder)), nextSeat(nextSeat(nextSeat(discarder))), nextSeat(discarder)]
    for (const [index, seat] of responders.entries()) {
      const legal = getLegalActions(state, seat)
      expect(legal).toEqual([{ kind: 'respond-to-discard', seat, choice: { kind: 'pass' } }])
      const result = applyEngineAction(state, legal[0]!)
      if (!result.accepted) throw new Error(result.error.message)
      state = result.state
      if (index < 2) {
        expect(state.phase.kind).toBe('discard-responses')
        expect(getLegalActions(state, seat)).toEqual([])
      }
    }

    const next = nextSeat(discarder)
    expect(state.phase).toEqual({ kind: 'player-action', actingSeat: next })
    expect(state.discards.at(-1)?.status).toBe('dead')
    expect(state.currentDraw).toMatchObject({ seat: next, source: 'front-wall' })
    expect(state.seats[next].concealedTiles).toHaveLength(17)
    expect(validateEngineState(state)).toEqual([])
  })

  it('replaces flowers after an ordinary draw and preserves front-wall provenance', () => {
    const initial = acceptedInitialState()
    if (initial.phase.kind !== 'player-action') throw new Error('Expected player action')
    const flowers = initial.wall.remainingTiles.filter((tile) => tile.kind === 'flower').slice(0, 2)
    const drawnTile = initial.wall.remainingTiles.find((tile) => tile.kind === 'suited')
    if (flowers.length !== 2 || drawnTile?.kind !== 'suited') throw new Error('Expected wall fixtures')
    const selectedIds = new Set([...flowers.map((tile) => tile.tileId), drawnTile.tileId])
    const middle = initial.wall.remainingTiles.filter((tile) => !selectedIds.has(tile.tileId))
    const arranged: EngineState = {
      ...initial,
      wall: { remainingTiles: [flowers[0]!, ...middle, drawnTile, flowers[1]!] },
    }
    expect(validateEngineState(arranged)).toEqual([])

    const discarder = arranged.phase.kind === 'player-action' ? arranged.phase.actingSeat : 0
    const discarded = applyEngineAction(arranged, getLegalActions(arranged, discarder)[0]!)
    if (!discarded.accepted) throw new Error(discarded.error.message)
    let state = discarded.state
    const next = nextSeat(discarder)
    const flowerCount = state.seats[next].flowers.length
    for (const seat of [next, nextSeat(next), nextSeat(nextSeat(next))]) {
      const passed = applyEngineAction(state, getLegalActions(state, seat)[0]!)
      if (!passed.accepted) throw new Error(passed.error.message)
      state = passed.state
    }

    expect(state.seats[next].flowers).toHaveLength(flowerCount + 2)
    expect(state.currentDraw).toEqual({ seat: next, tileId: drawnTile.tileId, source: 'front-wall' })
    expect(validateEngineState(state)).toEqual([])
  })

  it('ends in exhaustion after an all-pass discard when the wall is empty', () => {
    const wall = createCanonicalTileSet().filter((tile) => tile.kind === 'suited').slice(0, 65)
    const initialized = initializeHand({ dealerSeat: 2, wall })
    if (!initialized.accepted) throw new Error(initialized.error.message)
    let state = initialized.state
    const discard = getLegalActions(state, 2)[0]!
    const discarded = applyEngineAction(state, discard)
    if (!discarded.accepted) throw new Error(discarded.error.message)
    state = discarded.state
    for (const seat of [3, 0, 1] as const) {
      const passed = applyEngineAction(state, getLegalActions(state, seat)[0]!)
      if (!passed.accepted) throw new Error(passed.error.message)
      state = passed.state
    }

    expect(state.phase).toEqual({
      kind: 'ended',
      result: { kind: 'exhaustion-draw', nextDealerSeat: 3 },
    })
    expect(state.currentDraw).toBeNull()
    expect(state.discards).toHaveLength(1)
    expect(state.discards[0]?.status).toBe('dead')
    expect(validateEngineState(state)).toEqual([])
  })

  it('rejects invalid selections and unsupported actions without changing state', () => {
    const state = deepFreeze(actionStateWithFourTileMeld())
    const before = JSON.stringify(state)
    const invalidTileIds = [
      state.seats[1].concealedTiles[0]!.tileId,
      state.seats[0].melds[0]!.tiles[0].tileId,
      state.wall.remainingTiles[0]!.tileId,
      state.wall.remainingTiles.find((tile) => tile.kind === 'flower')!.tileId,
      'missing-tile',
    ]

    for (const tileId of invalidTileIds) {
      expect(applyEngineAction(state, { kind: 'discard', seat: 0, tileId }))
        .toMatchObject({ accepted: false, error: { code: 'invalid-tile-selection' } })
    }
    expect(applyEngineAction(state, { kind: 'discard', seat: 1, tileId: state.seats[1].concealedTiles[0]!.tileId }))
      .toMatchObject({ accepted: false, error: { code: 'out-of-turn' } })
    expect(applyEngineAction(state, { kind: 'win', seat: 0 }))
      .toMatchObject({ accepted: false, error: { code: 'illegal-action' } })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('rejects repeated discards, claims, duplicate passes, and ended-phase actions', () => {
    const initial = acceptedInitialState()
    if (initial.phase.kind !== 'player-action') throw new Error('Expected player action')
    const discard = getLegalActions(initial, initial.phase.actingSeat)[0]!
    const discarded = applyEngineAction(initial, discard)
    if (!discarded.accepted || discarded.state.phase.kind !== 'discard-responses') {
      throw new Error('Expected discard responses')
    }
    expect(applyEngineAction(discarded.state, discard))
      .toMatchObject({ accepted: false, error: { code: 'invalid-action-for-phase' } })

    const responder = nextSeat(initial.phase.actingSeat)
    expect(applyEngineAction(discarded.state, {
      kind: 'respond-to-discard',
      seat: responder,
      choice: { kind: 'pong', concealedTileIds: ['one', 'two'] },
    })).toMatchObject({ accepted: false, error: { code: 'illegal-action' } })

    const passed = applyEngineAction(discarded.state, getLegalActions(discarded.state, responder)[0]!)
    if (!passed.accepted) throw new Error(passed.error.message)
    expect(applyEngineAction(passed.state, { kind: 'respond-to-discard', seat: responder, choice: { kind: 'pass' } }))
      .toMatchObject({ accepted: false, error: { code: 'out-of-turn' } })

    const ended: EngineState = {
      ...initial,
      currentDraw: null,
      phase: { kind: 'ended', result: { kind: 'abort', nextDealerSeat: initial.dealerSeat } },
    }
    expect(getLegalActions(ended, initial.dealerSeat)).toEqual([])
    expect(applyEngineAction(ended, discard))
      .toMatchObject({ accepted: false, error: { code: 'invalid-action-for-phase' } })
  })
})
