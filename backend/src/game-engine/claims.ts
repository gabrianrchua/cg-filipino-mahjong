import type { Seat, SuitedTile, TileId } from '@cg-filipino-mahjong/shared'

import type {
  DiscardResponseChoice,
  EngineAction,
  EngineState,
  SubmittedDiscardResponse,
} from './model.js'
import { nextSeat } from './tiles.js'
import { findWinningDecomposition } from './wins.js'

type ResponsePhase = Extract<EngineState['phase'], { kind: 'discard-responses' }>
type MeldChoice = Extract<DiscardResponseChoice, { kind: 'chow' | 'pong' | 'open-kang' }>

function combinations<T>(items: readonly T[], count: number): readonly (readonly T[])[] {
  if (count === 0) return [[]]
  const result: T[][] = []
  for (let index = 0; index <= items.length - count; index += 1) {
    for (const suffix of combinations(items.slice(index + 1), count - 1)) {
      result.push([items[index]!, ...suffix])
    }
  }
  return result
}

function pendingDiscard(state: EngineState, phase: ResponsePhase) {
  return state.discards.find((discard) => discard.tile.tileId === phase.discardTileId)
}

function selectedTiles(
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

function isChow(tiles: readonly SuitedTile[]): boolean {
  if (tiles.length !== 3) return false
  const ordered = [...tiles].sort((left, right) => left.rank - right.rank)
  return ordered.every((tile) => tile.suit === ordered[0]!.suit)
    && ordered[1]!.rank === ordered[0]!.rank + 1
    && ordered[2]!.rank === ordered[0]!.rank + 2
}

function isMatchingSet(tiles: readonly SuitedTile[]): boolean {
  return tiles.length > 0
    && tiles.every((tile) => tile.suit === tiles[0]!.suit && tile.rank === tiles[0]!.rank)
}

export function validateDiscardResponseChoice(
  state: EngineState,
  phase: ResponsePhase,
  seat: Seat,
  choice: DiscardResponseChoice,
): string | null {
  const discard = pendingDiscard(state, phase)
  if (!discard) return 'The response phase has no matching pending discard.'
  if (choice.kind === 'pass') return null

  const owner = state.seats[seat]
  if (!owner) return 'The response seat does not exist.'
  if (choice.kind === 'win') {
    return findWinningDecomposition([...owner.concealedTiles, discard.tile], owner.melds) === null
      ? 'The pending discard does not complete this seat\'s hand.'
      : null
  }

  if (choice.kind === 'chow' && seat !== nextSeat(phase.discarderSeat)) {
    return 'Only the next seat may claim a discard for a non-winning chow.'
  }

  const expectedCount = choice.kind === 'open-kang' ? 3 : 2
  if (choice.concealedTileIds.length !== expectedCount) {
    return `${choice.kind} requires exactly ${expectedCount} concealed tiles.`
  }
  const concealed = selectedTiles(state, seat, choice.concealedTileIds)
  if (!concealed) return 'A claim must select distinct suited tiles in the responding seat\'s concealed hand.'

  const completed = [...concealed, discard.tile]
  if (choice.kind === 'chow') {
    return isChow(completed) ? null : 'The selected tiles and discard do not form a chow.'
  }
  return isMatchingSet(completed) ? null : `The selected tiles and discard do not form a ${choice.kind}.`
}

function chowChoices(
  concealed: readonly SuitedTile[],
  discard: SuitedTile,
): readonly Extract<DiscardResponseChoice, { kind: 'chow' }>[] {
  const patterns = [
    [discard.rank - 2, discard.rank - 1],
    [discard.rank - 1, discard.rank + 1],
    [discard.rank + 1, discard.rank + 2],
  ].filter((ranks) => ranks.every((rank) => rank >= 1 && rank <= 9))

  return patterns.flatMap(([firstRank, secondRank]) => {
    const first = concealed.find((tile) => tile.suit === discard.suit && tile.rank === firstRank)
    const second = concealed.find((tile) => tile.suit === discard.suit && tile.rank === secondRank)
    return first && second ? [{
      kind: 'chow' as const,
      concealedTileIds: [first.tileId, second.tileId] as const,
    }] : []
  })
}

export function getDiscardResponseActions(
  state: EngineState,
  phase: ResponsePhase,
  seat: Seat,
): readonly Extract<EngineAction, { kind: 'respond-to-discard' }>[] {
  const discard = pendingDiscard(state, phase)
  const owner = state.seats[seat]
  if (!discard || !owner) return Object.freeze([])

  const actions: Extract<EngineAction, { kind: 'respond-to-discard' }>[] = []
  if (findWinningDecomposition([...owner.concealedTiles, discard.tile], owner.melds) !== null) {
    actions.push({ kind: 'respond-to-discard', seat, choice: { kind: 'win' } })
  }

  const matching = owner.concealedTiles.filter((tile) => (
    tile.suit === discard.tile.suit && tile.rank === discard.tile.rank
  ))
  for (const tiles of combinations(matching, 3)) {
    actions.push({
      kind: 'respond-to-discard',
      seat,
      choice: { kind: 'open-kang', concealedTileIds: tiles.map((tile) => tile.tileId) as [TileId, TileId, TileId] },
    })
  }
  for (const tiles of combinations(matching, 2)) {
    actions.push({
      kind: 'respond-to-discard',
      seat,
      choice: { kind: 'pong', concealedTileIds: tiles.map((tile) => tile.tileId) as [TileId, TileId] },
    })
  }
  if (seat === nextSeat(phase.discarderSeat)) {
    for (const choice of chowChoices(owner.concealedTiles, discard.tile)) {
      actions.push({ kind: 'respond-to-discard', seat, choice })
    }
  }
  actions.push({ kind: 'respond-to-discard', seat, choice: { kind: 'pass' } })
  return Object.freeze(actions)
}

export function chooseResolvedResponse(
  phase: ResponsePhase,
  responses: readonly SubmittedDiscardResponse[],
): SubmittedDiscardResponse | null {
  const order = [
    nextSeat(phase.discarderSeat),
    nextSeat(nextSeat(phase.discarderSeat)),
    nextSeat(nextSeat(nextSeat(phase.discarderSeat))),
  ]
  const firstInTurnOrder = (choices: readonly SubmittedDiscardResponse[]) => (
    order.map((seat) => choices.find((response) => response.seat === seat)).find((response) => response !== undefined)
  ) ?? null

  const wins = responses.filter((response) => response.choice.kind === 'win')
  if (wins.length > 0) return firstInTurnOrder(wins)
  const matchingClaims = responses.filter((response) => (
    response.choice.kind === 'pong' || response.choice.kind === 'open-kang'
  ))
  if (matchingClaims.length > 0) return firstInTurnOrder(matchingClaims)
  const chows = responses.filter((response) => response.choice.kind === 'chow')
  return chows.length > 0 ? firstInTurnOrder(chows) : null
}

export function meldChoiceTiles(
  state: EngineState,
  phase: ResponsePhase,
  seat: Seat,
  choice: MeldChoice,
): readonly SuitedTile[] {
  const discard = pendingDiscard(state, phase)!
  const concealed = selectedTiles(state, seat, choice.concealedTileIds)!
  return [...concealed, discard.tile].sort((left, right) => (
    left.rank - right.rank || left.tileId.localeCompare(right.tileId)
  ))
}
