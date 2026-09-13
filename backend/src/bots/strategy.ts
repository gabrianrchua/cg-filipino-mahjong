import type { LegalChoice, RoomSnapshot, SuitedTile, TileId } from '@cg-filipino-mahjong/shared'

import type { RandomSource } from '../game-engine/index.js'

const PLAYER_ACTION_PRIORITY = ['sagasa', 'secret', 'discard'] as const
const DISCARD_RESPONSE_PRIORITY = ['open-kang', 'pong', 'chow', 'pass'] as const

/**
 * Chooses a basic bot action using only the same projected snapshot that a
 * player controlling the seat could see. The returned object is always one of
 * the legal-choice objects supplied by that snapshot.
 */
export function chooseBotLegalChoice(
  snapshot: RoomSnapshot,
  randomSource: RandomSource,
): LegalChoice | null {
  if (snapshot.stage !== 'playing' || snapshot.privateState == null) return null

  const { concealedTiles, legalChoices } = snapshot.privateState
  const win = legalChoices.find((choice) => choice.kind === 'win')
  if (win) return win

  const priorities = snapshot.phase.kind === 'discard-responses'
    ? DISCARD_RESPONSE_PRIORITY
    : snapshot.phase.kind === 'player-action'
      ? PLAYER_ACTION_PRIORITY
      : []

  for (const kind of priorities) {
    const candidates = legalChoices.filter((choice) => choice.kind === kind)
    if (candidates.length > 0) return chooseBestCandidate(candidates, concealedTiles, randomSource)
  }

  // A pass remains the safe fallback if a future claim choice reaches an older
  // bot implementation. This prevents the bot from stalling claim resolution.
  return legalChoices.find((choice) => choice.kind === 'pass') ?? null
}

// Concise integration-facing name used by the realtime coordinator.
export const chooseBotChoice = chooseBotLegalChoice

function chooseBestCandidate(
  choices: readonly LegalChoice[],
  concealedTiles: readonly SuitedTile[],
  randomSource: RandomSource,
): LegalChoice {
  let bestScore = Number.NEGATIVE_INFINITY
  let bestChoices: LegalChoice[] = []

  for (const choice of choices) {
    const removedIds = consumedConcealedTileIds(choice)
    const remainingTiles = concealedTiles.filter((tile) => !removedIds.has(tile.tileId))
    const score = scoreHandBuildingPotential(remainingTiles)

    if (score > bestScore) {
      bestScore = score
      bestChoices = [choice]
    } else if (score === bestScore) {
      bestChoices.push(choice)
    }
  }

  if (bestChoices.length === 1) return bestChoices[0]!
  const selectedIndex = randomSource.nextInt(bestChoices.length)
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= bestChoices.length) {
    throw new RangeError(
      `Random source returned ${selectedIndex}; expected an integer from 0 through ${bestChoices.length - 1}`,
    )
  }
  return bestChoices[selectedIndex]!
}

function consumedConcealedTileIds(choice: LegalChoice): ReadonlySet<TileId> {
  switch (choice.kind) {
    case 'discard':
      return new Set([choice.tileId])
    case 'secret':
    case 'chow':
    case 'pong':
    case 'open-kang':
      return new Set(choice.concealedTileIds)
    case 'sagasa':
      return new Set([choice.tileId])
    case 'win':
    case 'pass':
      return new Set()
  }
}

/**
 * Scores every unordered pair in a concealed hand: matching faces are worth
 * 3, adjacent same-suit ranks 2, and same-suit ranks two apart 1. Keeping the
 * highest post-action score favors pairs, pongs, and near-complete chows
 * without inspecting opponents or performing a search.
 */
export function scoreHandBuildingPotential(tiles: readonly SuitedTile[]): number {
  let score = 0
  for (let leftIndex = 0; leftIndex < tiles.length; leftIndex += 1) {
    const left = tiles[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < tiles.length; rightIndex += 1) {
      const right = tiles[rightIndex]!
      if (left.suit !== right.suit) continue
      const rankDistance = Math.abs(left.rank - right.rank)
      if (rankDistance === 0) score += 3
      else if (rankDistance === 1) score += 2
      else if (rankDistance === 2) score += 1
    }
  }
  return score
}
