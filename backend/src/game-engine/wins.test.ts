import type { Seat, SuitedTile } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  abortHand,
  applyEngineAction,
  createCanonicalTileSet,
  findWinningDecomposition,
  getLegalActions,
  initializeNextHand,
  nextSeat,
  validateEngineState,
  type DeclaredMeld,
  type DrawSource,
  type EngineState,
  type FourSeatStates,
  type SeatState,
} from './index.js'

const meldId = (suffix: number) => `10000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

type Face = readonly [SuitedTile['suit'], number, number]

function takeFaces(pool: ReturnType<typeof createCanonicalTileSet>[number][], faces: readonly Face[]): SuitedTile[] {
  const result: SuitedTile[] = []
  for (const [suit, rank, count] of faces) {
    for (let copy = 0; copy < count; copy += 1) {
      const index = pool.findIndex((tile) => tile.kind === 'suited' && tile.suit === suit && tile.rank === rank)
      const tile = pool[index]
      if (index < 0 || tile?.kind !== 'suited') throw new Error(`Missing ${suit} ${rank}`)
      result.push(tile)
      pool.splice(index, 1)
    }
  }
  return result
}

function takeAnySuited(pool: ReturnType<typeof createCanonicalTileSet>[number][], count: number): SuitedTile[] {
  const result: SuitedTile[] = []
  while (result.length < count) {
    const index = pool.findIndex((tile) => tile.kind === 'suited')
    const tile = pool[index]
    if (index < 0 || tile?.kind !== 'suited') throw new Error('Not enough suited tiles')
    result.push(tile)
    pool.splice(index, 1)
  }
  return result
}

const regularFaces: readonly Face[] = [
  ['sticks', 1, 3],
  ['sticks', 2, 3],
  ['sticks', 3, 3],
  ['balls', 4, 3],
  ['characters', 7, 3],
  ['characters', 9, 2],
]

function actionState(
  winnerSeat: Seat,
  dealerSeat: Seat,
  source: DrawSource,
  faces: readonly Face[] = regularFaces,
): EngineState {
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const winningTiles = takeFaces(pool, faces)
  const seats = ([0, 1, 2, 3] as const).map((seat): SeatState => ({
    seat,
    concealedTiles: seat === winnerSeat ? winningTiles : takeAnySuited(pool, 16),
    melds: [],
    flowers: [],
  })) as unknown as FourSeatStates
  const winningTile = winningTiles.at(-1)!
  return {
    tileUniverse,
    dealerSeat,
    seats,
    wall: { remainingTiles: pool },
    discards: [],
    currentDraw: { seat: winnerSeat, tileId: winningTile.tileId, source },
    phase: { kind: 'player-action', actingSeat: winnerSeat },
  }
}

function discardWinState(): { readonly state: EngineState; readonly winnerSeat: Seat; readonly winningTile: SuitedTile } {
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const complete = takeFaces(pool, regularFaces)
  const winningTile = complete.at(-1)!
  const winnerSeat: Seat = 2
  const winnerTiles = complete.slice(0, -1)
  const seats = ([0, 1, 2, 3] as const).map((seat): SeatState => ({
    seat,
    concealedTiles: seat === winnerSeat ? winnerTiles : takeAnySuited(pool, 16),
    melds: [],
    flowers: [],
  })) as unknown as FourSeatStates
  return {
    winnerSeat,
    winningTile,
    state: {
      tileUniverse,
      dealerSeat: 0,
      seats,
      wall: { remainingTiles: pool },
      discards: [{ tile: winningTile, discardedBy: 0, status: 'pending' }],
      currentDraw: null,
      phase: { kind: 'discard-responses', discarderSeat: 0, discardTileId: winningTile.tileId, responses: [] },
    },
  }
}

describe('winning decomposition', () => {
  it('backtracks through repeated suited ranks and rejects a near win', () => {
    const pool = [...createCanonicalTileSet()]
    const ambiguous = takeFaces(pool, [
      ['sticks', 1, 3],
      ['sticks', 2, 3],
      ['sticks', 3, 3],
      ['sticks', 4, 1],
      ['sticks', 5, 1],
      ['sticks', 6, 1],
      ['balls', 7, 3],
      ['characters', 9, 2],
    ])
    const decomposition = findWinningDecomposition(ambiguous, [])

    expect(decomposition?.kind).toBe('regular')
    expect(decomposition?.groups).toHaveLength(6)
    expect(new Set(decomposition?.groups.flatMap((group) => group.tiles.map((tile) => tile.tileId))).size).toBe(17)

    const replacement = takeFaces(pool, [['characters', 8, 1]])[0]!
    expect(findWinningDecomposition([...ambiguous.slice(0, -1), replacement], [])).toBeNull()
  })

  it('keeps every declared meld fixed and counts each four-tile meld as one group', () => {
    const pool = [...createCanonicalTileSet()]
    const chow = takeFaces(pool, [['sticks', 1, 1], ['sticks', 2, 1], ['sticks', 3, 1]]) as [SuitedTile, SuitedTile, SuitedTile]
    const pong = takeFaces(pool, [['sticks', 4, 3]]) as [SuitedTile, SuitedTile, SuitedTile]
    const openKang = takeFaces(pool, [['balls', 5, 4]]) as [SuitedTile, SuitedTile, SuitedTile, SuitedTile]
    const secret = takeFaces(pool, [['characters', 6, 4]]) as [SuitedTile, SuitedTile, SuitedTile, SuitedTile]
    const sagasa = takeFaces(pool, [['balls', 7, 4]]) as [SuitedTile, SuitedTile, SuitedTile, SuitedTile]
    const concealed = takeFaces(pool, [['characters', 8, 2]])
    const melds: readonly DeclaredMeld[] = [
      { meldId: meldId(1), kind: 'chow', tiles: chow },
      { meldId: meldId(2), kind: 'pong', tiles: pong },
      { meldId: meldId(3), kind: 'open-kang', tiles: openKang },
      { meldId: meldId(4), kind: 'secret', tiles: secret },
      { meldId: meldId(5), kind: 'sagasa', tiles: sagasa },
    ]
    const decomposition = findWinningDecomposition(concealed, melds)

    expect(decomposition).toMatchObject({ kind: 'regular' })
    expect(decomposition?.groups).toHaveLength(6)
    expect(decomposition?.groups.map((group) => group.kind)).toEqual([
      'pair', 'chow', 'pong', 'kang', 'kang', 'kang',
    ])
    expect(decomposition?.groups).toContainEqual({ kind: 'kang', tiles: secret })
  })

  it('recognizes seven pairs plus a pong, including a four-of-a-kind as two pairs', () => {
    const pool = [...createCanonicalTileSet()]
    const tiles = takeFaces(pool, [
      ['sticks', 1, 3],
      ['balls', 2, 4],
      ['balls', 4, 2],
      ['balls', 6, 2],
      ['characters', 1, 2],
      ['characters', 3, 2],
      ['characters', 5, 2],
    ])
    const decomposition = findWinningDecomposition(tiles, [])

    expect(decomposition?.kind).toBe('seven-pairs-plus-pong')
    expect(decomposition?.groups.filter((group) => group.kind === 'pair')).toHaveLength(7)
    expect(decomposition?.groups.filter((group) => group.kind === 'pong')).toHaveLength(1)

    const declared: readonly DeclaredMeld[] = [{
      meldId: meldId(6),
      kind: 'pong',
      tiles: tiles.slice(0, 3) as [SuitedTile, SuitedTile, SuitedTile],
    }]
    expect(findWinningDecomposition(tiles.slice(3), declared)).toBeNull()
  })
})

describe('winning transitions', () => {
  it.each(['dealer-opening', 'front-wall', 'gift'] as const)('offers and records an explicit %s win', (source) => {
    const state = actionState(0, 0, source)
    expect(validateEngineState(state)).toEqual([])
    expect(getLegalActions(state, 0)[0]).toEqual({ kind: 'win', seat: 0 })

    const result = applyEngineAction(state, { kind: 'win', seat: 0 })
    if (!result.accepted || result.state.phase.kind !== 'ended') throw new Error('Expected a win')
    expect(result.state.phase.result).toMatchObject({
      kind: 'win',
      winnerSeat: 0,
      source: 'self-draw',
      nextDealerSeat: 0,
    })
    expect(result.state.currentDraw?.source).toBe(source)
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('advances the dealer after a non-dealer self-draw win', () => {
    const state = actionState(2, 0, 'front-wall')
    const result = applyEngineAction(state, { kind: 'win', seat: 2 })
    expect(result).toMatchObject({
      accepted: true,
      state: { phase: { result: { winnerSeat: 2, nextDealerSeat: 1 } } },
    })
  })

  it('validates a discard win, waits for every response, and consumes the discard once', () => {
    const fixture = discardWinState()
    let state = fixture.state
    expect(validateEngineState(state)).toEqual([])
    expect(getLegalActions(state, fixture.winnerSeat)[0]).toEqual({
      kind: 'respond-to-discard',
      seat: fixture.winnerSeat,
      choice: { kind: 'win' },
    })

    for (const action of [
      { kind: 'respond-to-discard' as const, seat: fixture.winnerSeat, choice: { kind: 'win' as const } },
      { kind: 'respond-to-discard' as const, seat: 1 as const, choice: { kind: 'pass' as const } },
      { kind: 'respond-to-discard' as const, seat: 3 as const, choice: { kind: 'pass' as const } },
    ]) {
      const result = applyEngineAction(state, action)
      if (!result.accepted) throw new Error(result.error.message)
      state = result.state
    }

    expect(state.phase).toMatchObject({
      kind: 'ended',
      result: { kind: 'win', winnerSeat: 2, source: 'discard', nextDealerSeat: 1 },
    })
    expect(state.discards).toEqual([])
    expect(state.seats[2].concealedTiles.filter((tile) => tile.tileId === fixture.winningTile.tileId)).toHaveLength(1)
    expect(validateEngineState(state)).toEqual([])
  })

  it('selects the nearest discard winner independently of response arrival order', () => {
    const tileUniverse = createCanonicalTileSet()
    const pool = [...tileUniverse]
    const winningTile = takeFaces(pool, [['characters', 9, 1]])[0]!
    const seatOneTiles = [
      ...takeFaces(pool, [
        ['sticks', 1, 3], ['sticks', 2, 3], ['sticks', 3, 3], ['sticks', 4, 3], ['sticks', 5, 3],
      ]),
      ...takeFaces(pool, [['characters', 9, 1]]),
    ]
    const seatThreeTiles = [
      ...takeFaces(pool, [
        ['balls', 1, 3], ['balls', 2, 3], ['balls', 3, 3], ['balls', 4, 3], ['balls', 5, 3],
      ]),
      ...takeFaces(pool, [['characters', 9, 1]]),
    ]
    const seats = ([0, 1, 2, 3] as const).map((seat): SeatState => ({
      seat,
      concealedTiles: seat === 1 ? seatOneTiles : seat === 3 ? seatThreeTiles : takeAnySuited(pool, 16),
      melds: [],
      flowers: [],
    })) as unknown as FourSeatStates
    let state: EngineState = {
      tileUniverse,
      dealerSeat: 2,
      seats,
      wall: { remainingTiles: pool },
      discards: [{ tile: winningTile, discardedBy: 0, status: 'pending' }],
      currentDraw: null,
      phase: { kind: 'discard-responses', discarderSeat: 0, discardTileId: winningTile.tileId, responses: [] },
    }
    expect(validateEngineState(state)).toEqual([])

    for (const action of [
      { kind: 'respond-to-discard' as const, seat: 3 as const, choice: { kind: 'win' as const } },
      { kind: 'respond-to-discard' as const, seat: 2 as const, choice: { kind: 'pass' as const } },
      { kind: 'respond-to-discard' as const, seat: 1 as const, choice: { kind: 'win' as const } },
    ]) {
      const result = applyEngineAction(state, action)
      if (!result.accepted) throw new Error(result.error.message)
      state = result.state
    }

    expect(state.phase).toMatchObject({ kind: 'ended', result: { winnerSeat: 1, nextDealerSeat: 3 } })
    expect(state.seats[1].concealedTiles).toContainEqual(winningTile)
    expect(state.seats[3].concealedTiles).not.toContainEqual(winningTile)
    expect(validateEngineState(state)).toEqual([])
  })

  it('rejects explicit win requests for incomplete hands without changing state', () => {
    const complete = actionState(0, 0, 'front-wall')
    const poolTile = complete.wall.remainingTiles.find((tile) => tile.kind === 'suited')!
    const removed = complete.seats[0].concealedTiles.at(-1)!
    const incomplete: EngineState = {
      ...complete,
      seats: complete.seats.map((seat) => seat.seat === 0
        ? { ...seat, concealedTiles: [...seat.concealedTiles.slice(0, -1), poolTile] }
        : seat) as unknown as FourSeatStates,
      wall: { remainingTiles: [removed, ...complete.wall.remainingTiles.filter((tile) => tile.tileId !== poolTile.tileId)] },
      currentDraw: { seat: 0, tileId: poolTile.tileId, source: 'front-wall' },
    }
    const before = JSON.stringify(incomplete)

    expect(getLegalActions(incomplete, 0).some((action) => action.kind === 'win')).toBe(false)
    expect(applyEngineAction(incomplete, { kind: 'win', seat: 0 }))
      .toMatchObject({ accepted: false, error: { code: 'illegal-action' } })
    expect(JSON.stringify(incomplete)).toBe(before)
  })
})

describe('hand lifecycle', () => {
  it('preserves the dealer on abort and initializes a fresh next hand', () => {
    const active = actionState(2, 3, 'front-wall')
    const aborted = abortHand(active)
    if (!aborted.accepted || aborted.state.phase.kind !== 'ended') throw new Error('Expected abort')
    expect(aborted.state.phase.result).toEqual({ kind: 'abort', nextDealerSeat: 3 })

    const next = initializeNextHand(aborted.state, { wall: createCanonicalTileSet() })
    if (!next.accepted) throw new Error(next.error.message)
    expect(next.state.dealerSeat).toBe(3)
    expect(next.state.discards).toEqual([])
    expect(next.state.seats.every((seat) => seat.melds.length === 0 && seat.flowers.length === 0)).toBe(true)
    expect(next.state.phase).toEqual({ kind: 'player-action', actingSeat: 3 })
    expect(validateEngineState(next.state)).toEqual([])
  })

  it('safely resolves a pending discard when aborting during responses', () => {
    const fixture = discardWinState()
    const aborted = abortHand(fixture.state)
    if (!aborted.accepted) throw new Error(aborted.error.message)

    expect(aborted.state.phase).toEqual({ kind: 'ended', result: { kind: 'abort', nextDealerSeat: 0 } })
    expect(aborted.state.discards).toEqual([{ tile: fixture.winningTile, discardedBy: 0, status: 'dead' }])
    expect(validateEngineState(aborted.state)).toEqual([])
  })

  it('advances after exhaustion and refuses to replace an active hand', () => {
    const active = actionState(0, 1, 'dealer-opening')
    expect(initializeNextHand(active)).toMatchObject({
      accepted: false,
      error: { code: 'invalid-action-for-phase' },
    })

    const exhausted: EngineState = {
      ...active,
      currentDraw: null,
      phase: { kind: 'ended', result: { kind: 'exhaustion-draw', nextDealerSeat: nextSeat(active.dealerSeat) } },
    }
    const next = initializeNextHand(exhausted, { wall: createCanonicalTileSet() })
    expect(next).toMatchObject({ accepted: true, state: { dealerSeat: 2 } })
  })
})
