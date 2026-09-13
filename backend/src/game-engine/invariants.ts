import type { FlowerTile, PlayerSafeTile, Seat, SuitedTile } from '@cg-filipino-mahjong/shared'

import type {
  DeclaredMeld,
  EngineState,
  InvariantIssue,
  SeatState,
} from './model.js'
import { createCanonicalTileSet } from './tiles.js'

const canonicalTiles = createCanonicalTileSet()
const canonicalById = new Map(canonicalTiles.map((tile) => [tile.tileId, tile]))

const issue = (code: string, path: string, message: string): InvariantIssue => ({ code, path, message })

function sameIdentity(left: PlayerSafeTile, right: PlayerSafeTile): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'flower' && right.kind === 'flower') return left.identity === right.identity
  return left.kind === 'suited'
    && right.kind === 'suited'
    && left.suit === right.suit
    && left.rank === right.rank
}

function sameFace(left: SuitedTile, right: SuitedTile): boolean {
  return left.suit === right.suit && left.rank === right.rank
}

function validateMeld(meld: DeclaredMeld, path: string): readonly InvariantIssue[] {
  const issues: InvariantIssue[] = []
  const expectedLength = meld.kind === 'chow' || meld.kind === 'pong' ? 3 : 4
  if (meld.tiles.length !== expectedLength) {
    issues.push(issue('invalid-meld-length', `${path}.tiles`, `${meld.kind} must contain ${expectedLength} tiles`))
    return issues
  }

  if (meld.kind === 'chow') {
    const ordered = [...meld.tiles].sort((left, right) => left.rank - right.rank)
    if (
      !ordered.every((tile) => tile.suit === ordered[0]?.suit)
      || ordered[1]?.rank !== (ordered[0]?.rank ?? 0) + 1
      || ordered[2]?.rank !== (ordered[0]?.rank ?? 0) + 2
    ) {
      issues.push(issue('invalid-chow', `${path}.tiles`, 'A chow must be three consecutive ranks in one suit'))
    }
  } else if (!meld.tiles.every((tile) => sameFace(tile, meld.tiles[0]!))) {
    issues.push(issue('invalid-matching-meld', `${path}.tiles`, `${meld.kind} tiles must have the same face`))
  }

  return issues
}

function expectedConcealedCount(seat: SeatState, hasActionTile: boolean): number {
  return 16 - (3 * seat.melds.length) + (hasActionTile ? 1 : 0)
}

function collectTiles(state: EngineState, issues: InvariantIssue[]): Map<string, string[]> {
  const locations = new Map<string, string[]>()
  const add = (tile: PlayerSafeTile, path: string, expectedKind?: PlayerSafeTile['kind']) => {
    if (expectedKind && tile.kind !== expectedKind) {
      issues.push(issue('tile-in-wrong-zone', path, `Expected a ${expectedKind} tile, received ${tile.kind}`))
    }
    const canonical = canonicalById.get(tile.tileId)
    if (!canonical) {
      issues.push(issue('unknown-tile', path, `Unknown physical tile ID ${tile.tileId}`))
    } else if (!sameIdentity(tile, canonical)) {
      issues.push(issue('tile-identity-mismatch', path, `Tile ${tile.tileId} does not match its canonical identity`))
    }
    const paths = locations.get(tile.tileId) ?? []
    paths.push(path)
    locations.set(tile.tileId, paths)
  }

  state.wall.remainingTiles.forEach((tile, index) => add(tile, `wall.remainingTiles[${index}]`))
  state.seats.forEach((seat, seatIndex) => {
    seat.concealedTiles.forEach((tile, tileIndex) => add(tile, `seats[${seatIndex}].concealedTiles[${tileIndex}]`, 'suited'))
    seat.flowers.forEach((tile: FlowerTile, tileIndex) => add(tile, `seats[${seatIndex}].flowers[${tileIndex}]`, 'flower'))
    seat.melds.forEach((meld, meldIndex) => {
      meld.tiles.forEach((tile, tileIndex) => add(tile, `seats[${seatIndex}].melds[${meldIndex}].tiles[${tileIndex}]`, 'suited'))
    })
  })
  state.discards.forEach((discard, index) => add(discard.tile, `discards[${index}].tile`, 'suited'))

  return locations
}

export function validateEngineState(state: EngineState): readonly InvariantIssue[] {
  const issues: InvariantIssue[] = []
  const validSeats = new Set<Seat>([0, 1, 2, 3])
  const meldIds = new Set<string>()

  if (!validSeats.has(state.dealerSeat)) {
    issues.push(issue('invalid-dealer', 'dealerSeat', 'Dealer must be one of the four stable seats'))
  }
  if (state.seats.length !== 4) {
    issues.push(issue('invalid-seat-count', 'seats', 'Engine state must contain exactly four seats'))
  }

  state.seats.forEach((seat, index) => {
    if (seat.seat !== index) {
      issues.push(issue('unstable-seat-order', `seats[${index}].seat`, `Expected stable seat ${index}`))
    }
    if (seat.melds.length > 5) {
      issues.push(issue('too-many-melds', `seats[${index}].melds`, 'A hand cannot have more than five declared melds'))
    }
    seat.melds.forEach((meld, meldIndex) => {
      if (meldIds.has(meld.meldId)) {
        issues.push(issue('duplicate-meld-id', `seats[${index}].melds[${meldIndex}].meldId`, `Meld ID ${meld.meldId} is not unique`))
      }
      meldIds.add(meld.meldId)
      issues.push(...validateMeld(meld, `seats[${index}].melds[${meldIndex}]`))
    })
  })

  state.discards.forEach((discard, index) => {
    if (!validSeats.has(discard.discardedBy)) {
      issues.push(issue('invalid-discarder-seat', `discards[${index}].discardedBy`, 'Discarder must be one of the four stable seats'))
    }
  })

  const locations = collectTiles(state, issues)
  for (const tile of canonicalTiles) {
    const paths = locations.get(tile.tileId) ?? []
    if (paths.length === 0) {
      issues.push(issue('missing-tile', 'tiles', `Physical tile ${tile.tileId} is missing from state`))
    } else if (paths.length > 1) {
      issues.push(issue('duplicate-tile', paths.join(', '), `Physical tile ${tile.tileId} appears ${paths.length} times`))
    }
  }

  if (state.phase.kind === 'setup') {
    state.seats.forEach((seat, index) => {
      const maximum = seat.seat === state.dealerSeat ? 17 : 16
      if (seat.concealedTiles.length > maximum) {
        issues.push(issue('invalid-setup-hand-size', `seats[${index}].concealedTiles`, `Setup hand cannot exceed ${maximum} concealed tiles`))
      }
      if (seat.melds.length > 0) issues.push(issue('meld-during-setup', `seats[${index}].melds`, 'Setup cannot contain declared melds'))
    })
    if (state.discards.length > 0) issues.push(issue('discard-during-setup', 'discards', 'Setup cannot contain discards'))
  } else if (state.phase.kind === 'player-action') {
    const actingSeat = state.phase.actingSeat
    state.seats.forEach((seat, index) => {
      const expected = expectedConcealedCount(seat, seat.seat === actingSeat)
      if (seat.concealedTiles.length !== expected) {
        issues.push(issue('invalid-concealed-count', `seats[${index}].concealedTiles`, `Expected ${expected} concealed tiles for this phase`))
      }
    })
  } else if (state.phase.kind === 'discard-responses') {
    state.seats.forEach((seat, index) => {
      const expected = expectedConcealedCount(seat, false)
      if (seat.concealedTiles.length !== expected) {
        issues.push(issue('invalid-concealed-count', `seats[${index}].concealedTiles`, `Expected ${expected} concealed tiles while responses are pending`))
      }
    })
  }

  const pendingDiscards = state.discards.filter((discard) => discard.status === 'pending')
  if (state.phase.kind === 'discard-responses') {
    const responsePhase = state.phase
    const pending = pendingDiscards.filter((discard) => discard.tile.tileId === responsePhase.discardTileId)
    if (pending.length !== 1 || pending[0]?.discardedBy !== responsePhase.discarderSeat || pendingDiscards.length !== 1) {
      issues.push(issue('inconsistent-pending-discard', 'phase.discardTileId', 'Response phase must reference the one pending discard and its discarder'))
    }
    const responseSeats = new Set<Seat>()
    responsePhase.responses.forEach((response, index) => {
      if (response.seat === responsePhase.discarderSeat || responseSeats.has(response.seat)) {
        issues.push(issue('invalid-discard-response-seat', `phase.responses[${index}].seat`, 'Each opponent may respond exactly once'))
      }
      responseSeats.add(response.seat)
    })
  } else if (pendingDiscards.length > 0) {
    issues.push(issue('pending-discard-outside-response-phase', 'discards', 'A pending discard requires a discard-response phase'))
  }

  if (state.phase.kind === 'discard-responses' && state.currentDraw !== null) {
    issues.push(issue('draw-during-responses', 'currentDraw', 'Current draw must be cleared before discard responses'))
  }
  if (state.currentDraw !== null) {
    if (!validSeats.has(state.currentDraw.seat)) {
      issues.push(issue('invalid-current-draw-seat', 'currentDraw.seat', 'Draw owner must be one of the four stable seats'))
    }
    const owner = state.seats[state.currentDraw.seat]
    if (!owner?.concealedTiles.some((tile) => tile.tileId === state.currentDraw?.tileId)) {
      issues.push(issue('invalid-current-draw', 'currentDraw.tileId', 'Current draw must identify a concealed tile owned by its seat'))
    }
    if (state.phase.kind === 'player-action' && state.currentDraw.seat !== state.phase.actingSeat) {
      issues.push(issue('invalid-current-draw-seat', 'currentDraw.seat', 'Current draw must belong to the acting seat'))
    }
  }

  return Object.freeze(issues)
}
