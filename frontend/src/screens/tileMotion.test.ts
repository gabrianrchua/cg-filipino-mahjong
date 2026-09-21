import type { ActiveGameSnapshot } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import { createTableLayoutFixture } from './tableFixture.ts'
import { tileMotions } from './tileMotion.ts'

const nextRevision = (snapshot: ActiveGameSnapshot): ActiveGameSnapshot => ({
  ...snapshot, roomRevision: snapshot.roomRevision + 1, gameRevision: snapshot.gameRevision + 1,
})

describe('recipient tile motion', () => {
  it('recognizes a local draw by its physical tile ID', () => {
    const previous = createTableLayoutFixture()
    const tile = previous.privateState!.concealedTiles.at(-1)!
    const before: ActiveGameSnapshot = {
      ...previous,
      privateState: {
        ...previous.privateState!,
        concealedTiles: previous.privateState!.concealedTiles.slice(0, -1),
        drawnTileId: null,
      },
    }
    expect(tileMotions(before, nextRevision(previous))).toContainEqual({ kind: 'draw', tileId: tile.tileId })
  })

  it('recognizes a new discard but not another response in the same phase', () => {
    const next = createTableLayoutFixture()
    const previous: ActiveGameSnapshot = {
      ...next,
      gameRevision: next.gameRevision - 1,
      phase: { kind: 'player-action', phaseId: '00000000-0000-4000-8000-000000000599', actingSeat: 3 },
    }
    expect(tileMotions(previous, next)).toContainEqual({
      kind: 'discard', tileId: next.phase.kind === 'discard-responses' ? next.phase.latestDiscard.tileId : '', seat: 3,
    })
    const response: ActiveGameSnapshot = { ...next, gameRevision: next.gameRevision + 1 }
    expect(tileMotions(next, response)).toEqual([])
  })

  it('moves the claimed discard and local concealed tiles only after meld resolution', () => {
    const previous = createTableLayoutFixture()
    if (previous.phase.kind !== 'discard-responses') throw new Error('Expected response phase')
    const localTiles = previous.privateState!.concealedTiles.slice(0, 2)
    const meldId = '00000000-0000-4000-8000-000000000598'
    const meld = { meldId, kind: 'chow' as const, tiles: [...localTiles, previous.phase.latestDiscard] }
    const next: ActiveGameSnapshot = {
      ...nextRevision(previous),
      phase: { kind: 'player-action', phaseId: '00000000-0000-4000-8000-000000000597', actingSeat: 0 },
      seats: previous.seats.map((seat) => seat.seat === 0 ? { ...seat, melds: [...seat.melds, meld] } : seat),
      privateState: {
        ...previous.privateState!,
        concealedTiles: previous.privateState!.concealedTiles.slice(2),
        drawnTileId: null,
      },
    }
    expect(tileMotions(previous, next)).toEqual([
      { kind: 'meld', tileId: localTiles[0]!.tileId, meldId, seat: 0, claimed: false },
      { kind: 'meld', tileId: localTiles[1]!.tileId, meldId, seat: 0, claimed: false },
      { kind: 'meld', tileId: previous.phase.latestDiscard.tileId, meldId, seat: 0, claimed: true },
    ])
  })

  it('skips first views, skipped revisions, and a new hand', () => {
    const previous = createTableLayoutFixture()
    expect(tileMotions(null, previous)).toEqual([])
    expect(tileMotions(previous, { ...previous, gameRevision: previous.gameRevision + 2 })).toEqual([])
    expect(tileMotions(previous, { ...nextRevision(previous), handId: '00000000-0000-4000-8000-000000000596' })).toEqual([])
  })
})
