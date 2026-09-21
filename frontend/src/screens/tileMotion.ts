import type { ActiveGameSnapshot, Seat, TileId } from '@cg-filipino-mahjong/shared'

export type TileMotion =
  | { readonly kind: 'draw'; readonly tileId: TileId }
  | { readonly kind: 'discard'; readonly tileId: TileId; readonly seat: Seat }
  | { readonly kind: 'meld'; readonly tileId: TileId; readonly meldId: string; readonly seat: Seat; readonly claimed: boolean }

/** Only infer movement from adjacent gameplay states visible to this recipient. */
export function tileMotions(previous: ActiveGameSnapshot | null, next: ActiveGameSnapshot): readonly TileMotion[] {
  if (
    !previous
    || previous.roomId !== next.roomId
    || previous.handId !== next.handId
    || next.gameRevision !== previous.gameRevision + 1
  ) return []

  const motions: TileMotion[] = []
  const beforeHand = new Set(previous.privateState?.concealedTiles.map((tile) => tile.tileId) ?? [])
  const drawn = next.privateState?.drawnTileId
  if (drawn && !beforeHand.has(drawn) && next.privateState?.concealedTiles.some((tile) => tile.tileId === drawn)) {
    motions.push({ kind: 'draw', tileId: drawn })
  }

  if (next.phase.kind === 'discard-responses' && previous.phase.phaseId !== next.phase.phaseId) {
    motions.push({ kind: 'discard', tileId: next.phase.latestDiscard.tileId, seat: next.phase.discarderSeat })
  }

  if (previous.phase.kind === 'discard-responses' && next.phase.kind === 'player-action') {
    const claimedId = previous.phase.latestDiscard.tileId
    for (const seat of next.seats) {
      const previousMeldIds = new Set(previous.seats[seat.seat]?.melds.map((meld) => meld.meldId) ?? [])
      for (const meld of seat.melds) {
        if (previousMeldIds.has(meld.meldId) || !('tiles' in meld) || meld.kind === 'secret') continue
        for (const tile of meld.tiles) {
          motions.push({
            kind: 'meld', tileId: tile.tileId, meldId: meld.meldId, seat: seat.seat,
            claimed: tile.tileId === claimedId,
          })
        }
      }
    }
  }

  return motions
}
