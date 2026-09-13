import type { Seat, SuitedTile } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  applyEngineAction,
  createCanonicalTileSet,
  getLegalActions,
  validateEngineState,
  type DiscardResponseChoice,
  type EngineAction,
  type EngineState,
  type FourSeatStates,
  type SeatState,
} from './index.js'

type Face = readonly [SuitedTile['suit'], number, number]
type ResponseAction = Extract<EngineAction, { kind: 'respond-to-discard' }>

const meldId = (suffix: number) => `20000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

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

function fillSuited(pool: ReturnType<typeof createCanonicalTileSet>[number][], tiles: SuitedTile[]): SuitedTile[] {
  while (tiles.length < 16) {
    const index = pool.findIndex((tile) => tile.kind === 'suited')
    const tile = pool[index]
    if (index < 0 || tile?.kind !== 'suited') throw new Error('Not enough suited tiles')
    tiles.push(tile)
    pool.splice(index, 1)
  }
  return tiles
}

function responseState(
  hands: Partial<Record<Seat, readonly Face[]>>,
  discardFace: readonly [SuitedTile['suit'], number] = ['balls', 5],
  discarderSeat: Seat = 0,
): EngineState {
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const discard = takeFaces(pool, [[discardFace[0], discardFace[1], 1]])[0]!
  const allocated = ([0, 1, 2, 3] as const).map((seat) => takeFaces(pool, hands[seat] ?? []))
  const seats = ([0, 1, 2, 3] as const).map((seat): SeatState => ({
    seat,
    concealedTiles: fillSuited(pool, allocated[seat]!),
    melds: [],
    flowers: [],
  })) as unknown as FourSeatStates

  return {
    tileUniverse,
    dealerSeat: 0,
    seats,
    wall: { remainingTiles: pool },
    discards: [{ tile: discard, discardedBy: discarderSeat, status: 'pending' }],
    currentDraw: null,
    phase: { kind: 'discard-responses', discarderSeat, discardTileId: discard.tileId, responses: [] },
  }
}

function actionOf(state: EngineState, seat: Seat, kind: DiscardResponseChoice['kind']): ResponseAction {
  const action = getLegalActions(state, seat).find((candidate): candidate is ResponseAction => (
    candidate.kind === 'respond-to-discard' && candidate.choice.kind === kind
  ))
  if (!action) throw new Error(`Missing ${kind} action for seat ${seat}`)
  return action
}

function permutations<T>(items: readonly T[]): readonly (readonly T[])[] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => permutations([
    ...items.slice(0, index),
    ...items.slice(index + 1),
  ]).map((rest) => [item, ...rest]))
}

function resolve(state: EngineState, actions: readonly ResponseAction[]): EngineState {
  let current = state
  for (const action of actions) {
    const result = applyEngineAction(current, action, { createMeldId: () => meldId(1) })
    if (!result.accepted) throw new Error(result.error.message)
    current = result.state
  }
  return current
}

describe('discard claim choices', () => {
  it('offers every physical chow selection only to the next seat', () => {
    const state = responseState({ 1: [['balls', 3, 2], ['balls', 4, 2]] })
    expect(validateEngineState(state)).toEqual([])

    const chows = getLegalActions(state, 1).filter((action): action is ResponseAction => (
      action.kind === 'respond-to-discard' && action.choice.kind === 'chow'
    ))
    const selected = chows.map((action) => (
      action.choice.kind === 'chow' ? [...action.choice.concealedTileIds].sort().join('|') : ''
    ))
    const threes = state.seats[1].concealedTiles.filter((tile) => tile.suit === 'balls' && tile.rank === 3)
    const fours = state.seats[1].concealedTiles.filter((tile) => tile.suit === 'balls' && tile.rank === 4)
    const expected = threes.flatMap((three) => fours.map((four) => [three.tileId, four.tileId].sort().join('|')))

    expect(selected.sort()).toEqual(expected.sort())
    expect(getLegalActions(state, 2).some((action) => (
      action.kind === 'respond-to-discard' && action.choice.kind === 'chow'
    ))).toBe(false)
  })

  it('offers pong and open-kang alternatives from exact matching concealed tiles', () => {
    const state = responseState({ 2: [['balls', 5, 3]] })
    const responses = getLegalActions(state, 2)

    expect(responses.filter((action) => action.kind === 'respond-to-discard' && action.choice.kind === 'pong'))
      .toHaveLength(3)
    expect(responses.filter((action) => action.kind === 'respond-to-discard' && action.choice.kind === 'open-kang'))
      .toHaveLength(1)
    expect(responses.at(-1)).toEqual({ kind: 'respond-to-discard', seat: 2, choice: { kind: 'pass' } })
  })

  it('rejects invalid, duplicate, foreign, and wrong-seat selections without mutation', () => {
    const state = responseState({
      1: [['balls', 3, 1], ['balls', 4, 1], ['balls', 5, 2]],
      2: [['balls', 3, 1], ['balls', 4, 1]],
    })
    const before = JSON.stringify(state)
    const matching = state.seats[1].concealedTiles.filter((tile) => tile.suit === 'balls' && tile.rank === 5)
    const chow = state.seats[1].concealedTiles.filter((tile) => tile.suit === 'balls' && [3, 4].includes(tile.rank))
    const seatTwoChow = state.seats[2].concealedTiles.filter((tile) => tile.suit === 'balls' && [3, 4].includes(tile.rank))
    const invalid: readonly ResponseAction[] = [
      { kind: 'respond-to-discard', seat: 1, choice: { kind: 'pong', concealedTileIds: [matching[0]!.tileId, matching[0]!.tileId] } },
      { kind: 'respond-to-discard', seat: 1, choice: { kind: 'pong', concealedTileIds: [chow[0]!.tileId, chow[1]!.tileId] } },
      { kind: 'respond-to-discard', seat: 1, choice: { kind: 'pong', concealedTileIds: [matching[0]!.tileId, state.seats[2].concealedTiles[0]!.tileId] } },
      { kind: 'respond-to-discard', seat: 1, choice: { kind: 'chow', concealedTileIds: [chow[0]!.tileId, 'missing-tile'] } },
      { kind: 'respond-to-discard', seat: 2, choice: { kind: 'chow', concealedTileIds: [seatTwoChow[0]!.tileId, seatTwoChow[1]!.tileId] } },
    ]

    for (const action of invalid) {
      expect(applyEngineAction(state, action)).toMatchObject({ accepted: false, error: { code: 'illegal-action' } })
      expect(JSON.stringify(state)).toBe(before)
    }
  })
})

describe('deterministic discard resolution', () => {
  it('resolves win over pong over chow for every response arrival order', () => {
    const state = responseState({
      1: [['balls', 3, 1], ['balls', 4, 1]],
      2: [['balls', 5, 2]],
      3: [
        ['sticks', 1, 3], ['sticks', 2, 3], ['sticks', 3, 3],
        ['characters', 7, 3], ['characters', 9, 3], ['balls', 5, 1],
      ],
    })
    expect(validateEngineState(state)).toEqual([])
    const actions = [actionOf(state, 1, 'chow'), actionOf(state, 2, 'pong'), actionOf(state, 3, 'win')]

    for (const order of permutations(actions)) {
      const resolved = resolve(state, order)
      expect(resolved.phase).toMatchObject({ kind: 'ended', result: { kind: 'win', winnerSeat: 3, source: 'discard' } })
      expect(resolved.discards).toEqual([])
      expect(validateEngineState(resolved)).toEqual([])
    }
  })

  it('resolves pong over chow for every response arrival order and skips intervening draws', () => {
    const state = responseState({
      1: [['balls', 3, 1], ['balls', 4, 1]],
      2: [['balls', 5, 2]],
    })
    const pong = actionOf(state, 2, 'pong')
    const actions = [actionOf(state, 1, 'chow'), pong, actionOf(state, 3, 'pass')]
    const selectedIds: readonly string[] = pong.choice.kind === 'pong' ? pong.choice.concealedTileIds : []

    for (const order of permutations(actions)) {
      const resolved = resolve(state, order)
      expect(resolved.phase).toEqual({ kind: 'player-action', actingSeat: 2 })
      expect(resolved.currentDraw).toBeNull()
      expect(resolved.wall).toEqual(state.wall)
      expect(resolved.discards).toEqual([])
      expect(resolved.seats[2].melds).toMatchObject([{ meldId: meldId(1), kind: 'pong' }])
      expect(resolved.seats[2].melds[0]?.tiles).toHaveLength(3)
      expect(resolved.seats[2].concealedTiles.some((tile) => selectedIds.includes(tile.tileId))).toBe(false)
      expect(validateEngineState(resolved)).toEqual([])
    }
  })

  it('selects the nearest competing winner for every response arrival order', () => {
    const winningWait: readonly Face[] = [
      ['sticks', 1, 3], ['sticks', 2, 3], ['sticks', 3, 3],
      ['characters', 7, 3], ['characters', 9, 3], ['balls', 5, 1],
    ]
    const alternateWait: readonly Face[] = [
      ['balls', 1, 3], ['balls', 2, 3], ['balls', 3, 3],
      ['characters', 4, 3], ['characters', 6, 3], ['balls', 5, 1],
    ]
    const state = responseState({ 1: winningWait, 3: alternateWait })
    const actions = [actionOf(state, 1, 'win'), actionOf(state, 2, 'pass'), actionOf(state, 3, 'win')]

    for (const order of permutations(actions)) {
      const resolved = resolve(state, order)
      expect(resolved.phase).toMatchObject({ kind: 'ended', result: { kind: 'win', winnerSeat: 1 } })
      expect(validateEngineState(resolved)).toEqual([])
    }
  })

  it('gives an open-kang claimant a back-wall gift through chained flower replacements', () => {
    const initial = responseState({ 2: [['balls', 5, 3]] })
    const flowers = initial.wall.remainingTiles.filter((tile) => tile.kind === 'flower').slice(0, 2)
    const gift = initial.wall.remainingTiles.find((tile) => tile.kind === 'suited')
    if (flowers.length !== 2 || gift?.kind !== 'suited') throw new Error('Missing gift fixture tiles')
    const movedIds = new Set([...flowers.map((tile) => tile.tileId), gift.tileId])
    const state: EngineState = {
      ...initial,
      wall: {
        remainingTiles: [
          ...initial.wall.remainingTiles.filter((tile) => !movedIds.has(tile.tileId)),
          gift,
          flowers[1]!,
          flowers[0]!,
        ],
      },
    }
    const resolved = resolve(state, [
      actionOf(state, 1, 'pass'),
      actionOf(state, 2, 'open-kang'),
      actionOf(state, 3, 'pass'),
    ])

    expect(resolved.phase).toEqual({ kind: 'player-action', actingSeat: 2 })
    expect(resolved.seats[2].melds).toMatchObject([{ kind: 'open-kang' }])
    expect(resolved.seats[2].flowers.slice(-2)).toEqual(flowers)
    expect(resolved.currentDraw).toEqual({ seat: 2, tileId: gift.tileId, source: 'gift' })
    expect(resolved.discards).toEqual([])
    expect(validateEngineState(resolved)).toEqual([])
  })

  it('commits an open-kang before ending when its required gift is exhausted', () => {
    const initial = responseState({ 2: [['balls', 5, 3]] })
    const state: EngineState = {
      ...initial,
      tileUniverse: [
        ...initial.seats.flatMap((seat) => seat.concealedTiles),
        initial.discards[0]!.tile,
      ],
      wall: { remainingTiles: [] },
    }
    expect(validateEngineState(state)).toEqual([])
    const resolved = resolve(state, [
      actionOf(state, 1, 'pass'),
      actionOf(state, 2, 'open-kang'),
      actionOf(state, 3, 'pass'),
    ])

    expect(resolved.phase).toEqual({
      kind: 'ended',
      result: { kind: 'exhaustion-draw', nextDealerSeat: 1 },
    })
    expect(resolved.seats[2].melds).toMatchObject([{ kind: 'open-kang' }])
    expect(resolved.discards).toEqual([])
    expect(validateEngineState(resolved)).toEqual([])
  })

  it('rejects malformed generated meld IDs without committing the final response', () => {
    const state = responseState({ 2: [['balls', 5, 2]] })
    const afterFirst = applyEngineAction(state, actionOf(state, 1, 'pass'))
    if (!afterFirst.accepted) throw new Error(afterFirst.error.message)
    const afterSecond = applyEngineAction(afterFirst.state, actionOf(afterFirst.state, 2, 'pong'))
    if (!afterSecond.accepted) throw new Error(afterSecond.error.message)
    const before = JSON.stringify(afterSecond.state)
    const result = applyEngineAction(afterSecond.state, actionOf(afterSecond.state, 3, 'pass'), {
      createMeldId: () => 'not-a-uuid',
    })

    expect(result).toMatchObject({ accepted: false, error: { code: 'invalid-meld-id' } })
    expect(JSON.stringify(afterSecond.state)).toBe(before)
  })

  it('keeps malformed submitted response contents private but invalid at the engine boundary', () => {
    const state = responseState({ 1: [['balls', 3, 1], ['balls', 4, 1]] })
    if (state.phase.kind !== 'discard-responses') throw new Error('Expected response phase')
    const malformed: EngineState = {
      ...state,
      phase: {
        ...state.phase,
        responses: [{
          seat: 2,
          choice: {
            kind: 'chow',
            concealedTileIds: state.seats[2].concealedTiles.slice(0, 2).map((tile) => tile.tileId) as [string, string],
          },
        }],
      },
    }

    expect(validateEngineState(malformed).map((issue) => issue.code)).toContain('invalid-discard-response-choice')
    expect(getLegalActions(malformed, 3)).toEqual([])
  })
})
