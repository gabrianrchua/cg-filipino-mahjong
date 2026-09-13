import type { MeldId, SuitedTile } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  applyEngineAction,
  createCanonicalTileSet,
  getLegalActions,
  projectMeldsForRecipient,
  validateEngineState,
  type DeclaredMeld,
  type EngineAction,
  type EngineState,
  type FourSeatStates,
  type SeatState,
} from './index.js'

type Face = readonly [SuitedTile['suit'], number, number]
type SecretAction = Extract<EngineAction, { kind: 'secret' }>
type SagasaAction = Extract<EngineAction, { kind: 'sagasa' }>

const meldId = (suffix: number): MeldId => (
  `50000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
)

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

function fillSuited(
  pool: ReturnType<typeof createCanonicalTileSet>[number][],
  tiles: SuitedTile[],
  count: number,
): SuitedTile[] {
  while (tiles.length < count) {
    const index = pool.findIndex((tile) => tile.kind === 'suited')
    const tile = pool[index]
    if (index < 0 || tile?.kind !== 'suited') throw new Error('Not enough suited tiles')
    tiles.push(tile)
    pool.splice(index, 1)
  }
  return tiles
}

function actionState(
  concealedFaces: readonly Face[],
  declaredMelds: readonly DeclaredMeld[] = [],
): { readonly state: EngineState; readonly selected: readonly SuitedTile[] } {
  const tileUniverse = createCanonicalTileSet()
  const pool = [...tileUniverse]
  const meldTileIds = new Set(declaredMelds.flatMap((meld) => meld.tiles.map((tile) => tile.tileId)))
  for (let index = pool.length - 1; index >= 0; index -= 1) {
    if (meldTileIds.has(pool[index]!.tileId)) pool.splice(index, 1)
  }
  const selected = takeFaces(pool, concealedFaces)
  const ownerTiles = fillSuited(pool, [...selected], 17 - (3 * declaredMelds.length))
  const seats = ([0, 1, 2, 3] as const).map((seat): SeatState => ({
    seat,
    concealedTiles: seat === 0 ? ownerTiles : fillSuited(pool, [], 16),
    melds: seat === 0 ? declaredMelds : [],
    flowers: [],
  })) as unknown as FourSeatStates
  return {
    selected,
    state: {
      tileUniverse,
      dealerSeat: 0,
      seats,
      wall: { remainingTiles: pool },
      discards: [],
      currentDraw: null,
      phase: { kind: 'player-action', actingSeat: 0 },
    },
  }
}

function openPongState(): { readonly state: EngineState; readonly fourth: SuitedTile } {
  const canonical = createCanonicalTileSet()
  const pongTiles = canonical.filter((tile): tile is SuitedTile => (
    tile.kind === 'suited' && tile.suit === 'balls' && tile.rank === 5
  )).slice(0, 3) as [SuitedTile, SuitedTile, SuitedTile]
  const pong: DeclaredMeld = { meldId: meldId(1), kind: 'pong', tiles: pongTiles }
  const fixture = actionState([['balls', 5, 1]], [pong])
  return { state: fixture.state, fourth: fixture.selected[0]! }
}

function withBackDraws(state: EngineState, drawsInOrder: readonly EngineState['tileUniverse'][number][]): EngineState {
  const moved = new Set(drawsInOrder.map((tile) => tile.tileId))
  return {
    ...state,
    wall: {
      remainingTiles: [
        ...state.wall.remainingTiles.filter((tile) => !moved.has(tile.tileId)),
        ...[...drawsInOrder].reverse(),
      ],
    },
  }
}

function specialAction<T extends SecretAction['kind'] | SagasaAction['kind']>(
  state: EngineState,
  kind: T,
): Extract<EngineAction, { kind: T }> {
  const action = getLegalActions(state, 0).find((candidate) => candidate.kind === kind)
  if (!action) throw new Error(`Missing ${kind} action`)
  return action as Extract<EngineAction, { kind: T }>
}

describe('secret declarations', () => {
  it('offers and declares a concealed four-of-a-kind before resolving a flower gift chain', () => {
    const fixture = actionState([['characters', 7, 4]])
    const flowers = fixture.state.wall.remainingTiles.filter((tile) => tile.kind === 'flower').slice(0, 2)
    const gift = fixture.state.wall.remainingTiles.find((tile) => tile.kind === 'suited')
    if (flowers.length !== 2 || gift?.kind !== 'suited') throw new Error('Missing gift fixtures')
    const state = withBackDraws(fixture.state, [...flowers, gift])
    expect(validateEngineState(state)).toEqual([])

    const action = specialAction(state, 'secret')
    const result = applyEngineAction(state, action, { createMeldId: () => meldId(2) })
    if (!result.accepted) throw new Error(result.error.message)

    expect(result.state.seats[0].melds).toMatchObject([{ meldId: meldId(2), kind: 'secret' }])
    expect(result.state.seats[0].melds[0]?.tiles).toHaveLength(4)
    expect(result.state.seats[0].flowers).toEqual(flowers)
    expect(result.state.currentDraw).toEqual({ seat: 0, tileId: gift.tileId, source: 'gift' })
    expect(result.state.phase).toEqual({ kind: 'player-action', actingSeat: 0 })
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('supports successive secrets and gives each declaration its own gift', () => {
    const fixture = actionState([['balls', 2, 4], ['characters', 8, 4]])
    const gifts = fixture.state.wall.remainingTiles.filter((tile) => tile.kind === 'suited').slice(0, 2)
    let state = withBackDraws(fixture.state, gifts)
    const first = applyEngineAction(state, specialAction(state, 'secret'), { createMeldId: () => meldId(2) })
    if (!first.accepted) throw new Error(first.error.message)
    state = first.state
    const second = applyEngineAction(state, specialAction(state, 'secret'), { createMeldId: () => meldId(3) })
    if (!second.accepted) throw new Error(second.error.message)

    expect(second.state.seats[0].melds.map((meld) => meld.kind)).toEqual(['secret', 'secret'])
    expect(second.state.currentDraw).toEqual({ seat: 0, tileId: gifts[1]!.tileId, source: 'gift' })
    expect(validateEngineState(second.state)).toEqual([])
  })

  it('rejects duplicate, mixed, foreign, and out-of-turn selections without mutation', () => {
    const fixture = actionState([['sticks', 9, 4], ['balls', 4, 1]])
    const matching = fixture.selected.slice(0, 4)
    const mixed = fixture.selected[4]!
    const before = JSON.stringify(fixture.state)
    const invalid: readonly EngineAction[] = [
      { kind: 'secret', seat: 0, concealedTileIds: [matching[0]!.tileId, matching[0]!.tileId, matching[2]!.tileId, matching[3]!.tileId] },
      { kind: 'secret', seat: 0, concealedTileIds: [matching[0]!.tileId, matching[1]!.tileId, matching[2]!.tileId, mixed.tileId] },
      { kind: 'secret', seat: 0, concealedTileIds: [matching[0]!.tileId, matching[1]!.tileId, matching[2]!.tileId, fixture.state.seats[1].concealedTiles[0]!.tileId] },
      { kind: 'secret', seat: 1, concealedTileIds: matching.map((tile) => tile.tileId) as [string, string, string, string] },
    ]

    for (const action of invalid) {
      expect(applyEngineAction(fixture.state, action).accepted).toBe(false)
      expect(JSON.stringify(fixture.state)).toBe(before)
    }
  })

  it('commits the secret before a required gift exhausts the wall', () => {
    const fixture = actionState([['characters', 9, 4]])
    const state: EngineState = {
      ...fixture.state,
      tileUniverse: fixture.state.seats.flatMap((seat) => [
        ...seat.concealedTiles,
        ...seat.melds.flatMap((meld) => meld.tiles),
        ...seat.flowers,
      ]),
      wall: { remainingTiles: [] },
    }
    const result = applyEngineAction(state, specialAction(state, 'secret'), { createMeldId: () => meldId(2) })
    if (!result.accepted) throw new Error(result.error.message)

    expect(result.state.seats[0].melds).toMatchObject([{ kind: 'secret' }])
    expect(result.state.phase).toEqual({
      kind: 'ended',
      result: { kind: 'exhaustion-draw', nextDealerSeat: 1 },
    })
    expect(validateEngineState(result.state)).toEqual([])
  })
})

describe('sagasa declarations', () => {
  it('upgrades the existing pong only with its matching current draw and preserves its meld ID', () => {
    const fixture = openPongState()
    const flowers = fixture.state.wall.remainingTiles.filter((tile) => tile.kind === 'flower').slice(0, 2)
    const gift = fixture.state.wall.remainingTiles.find((tile) => tile.kind === 'suited')
    if (flowers.length !== 2 || gift?.kind !== 'suited') throw new Error('Missing gift fixtures')
    const state = withBackDraws({
      ...fixture.state,
      currentDraw: { seat: 0, tileId: fixture.fourth.tileId, source: 'front-wall' },
    }, [...flowers, gift])
    const result = applyEngineAction(state, specialAction(state, 'sagasa'))
    if (!result.accepted) throw new Error(result.error.message)

    expect(result.state.seats[0].melds).toHaveLength(1)
    expect(result.state.seats[0].melds[0]).toMatchObject({ meldId: meldId(1), kind: 'sagasa' })
    expect(result.state.seats[0].melds[0]?.tiles).toHaveLength(4)
    expect(result.state.seats[0].concealedTiles).not.toContainEqual(fixture.fourth)
    expect(result.state.seats[0].flowers).toEqual(flowers)
    expect(result.state.currentDraw).toEqual({ seat: 0, tileId: gift.tileId, source: 'gift' })
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('commits the pong upgrade before a required gift exhausts the wall', () => {
    const fixture = openPongState()
    const withDraw: EngineState = {
      ...fixture.state,
      tileUniverse: fixture.state.seats.flatMap((seat) => [
        ...seat.concealedTiles,
        ...seat.melds.flatMap((meld) => meld.tiles),
      ]),
      wall: { remainingTiles: [] },
      currentDraw: { seat: 0, tileId: fixture.fourth.tileId, source: 'gift' },
    }
    const result = applyEngineAction(withDraw, specialAction(withDraw, 'sagasa'))
    if (!result.accepted) throw new Error(result.error.message)

    expect(result.state.seats[0].melds).toMatchObject([{ meldId: meldId(1), kind: 'sagasa' }])
    expect(result.state.phase).toEqual({
      kind: 'ended',
      result: { kind: 'exhaustion-draw', nextDealerSeat: 1 },
    })
    expect(validateEngineState(result.state)).toEqual([])
  })

  it('rejects a stored matching tile when the current draw is different', () => {
    const fixture = openPongState()
    const different = fixture.state.seats[0].concealedTiles.find((tile) => tile.tileId !== fixture.fourth.tileId)!
    const state: EngineState = {
      ...fixture.state,
      currentDraw: { seat: 0, tileId: different.tileId, source: 'front-wall' },
    }
    const forged: SagasaAction = {
      kind: 'sagasa', seat: 0, meldId: meldId(1), tileId: fixture.fourth.tileId,
    }

    expect(getLegalActions(state, 0).some((action) => action.kind === 'sagasa')).toBe(false)
    expect(applyEngineAction(state, forged)).toMatchObject({ accepted: false, error: { code: 'illegal-action' } })
  })

  it('does not permit a discarded fourth tile to extend the pong', () => {
    const fixture = openPongState()
    const drawn: EngineState = {
      ...fixture.state,
      currentDraw: { seat: 0, tileId: fixture.fourth.tileId, source: 'front-wall' },
    }
    const discarded = applyEngineAction(drawn, {
      kind: 'discard', seat: 0, tileId: fixture.fourth.tileId,
    })
    if (!discarded.accepted) throw new Error(discarded.error.message)
    const forged: SagasaAction = {
      kind: 'sagasa', seat: 0, meldId: meldId(1), tileId: fixture.fourth.tileId,
    }

    expect(getLegalActions(discarded.state, 0)).toEqual([])
    expect(applyEngineAction(discarded.state, forged)).toMatchObject({
      accepted: false,
      error: { code: 'invalid-action-for-phase' },
    })
  })
})

describe('secret visibility', () => {
  it('reveals a secret to its owner and exposes only its existence and count to opponents', () => {
    const fixture = actionState([['balls', 7, 4]])
    const state: EngineState = {
      ...fixture.state,
      tileUniverse: fixture.state.seats.flatMap((seat) => seat.concealedTiles),
      wall: { remainingTiles: [] },
    }
    const result = applyEngineAction(state, specialAction(state, 'secret'), { createMeldId: () => meldId(2) })
    if (!result.accepted) throw new Error(result.error.message)
    const owner = projectMeldsForRecipient(result.state.seats[0], 0)[0]
    const observer = projectMeldsForRecipient(result.state.seats[0], 1)[0]

    expect(owner).toMatchObject({ kind: 'secret', visibility: 'owner', tiles: expect.any(Array) })
    expect(observer).toEqual({ meldId: meldId(2), kind: 'secret', visibility: 'masked', tileCount: 4 })
    expect(observer).not.toHaveProperty('tiles')
  })
})
