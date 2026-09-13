import type { PlayerVisibleMeld, Seat } from '@cg-filipino-mahjong/shared'

import type { SeatState } from './model.js'

/** Projects declared melds without allowing a secret's identity across the recipient boundary. */
export function projectMeldsForRecipient(
  owner: SeatState,
  recipientSeat: Seat,
): readonly PlayerVisibleMeld[] {
  return Object.freeze(owner.melds.map((meld): PlayerVisibleMeld => {
    if (meld.kind !== 'secret') return { ...meld, tiles: [...meld.tiles] }
    if (owner.seat === recipientSeat) {
      return {
        meldId: meld.meldId,
        kind: 'secret',
        visibility: 'owner',
        tiles: [...meld.tiles],
      }
    }
    return {
      meldId: meld.meldId,
      kind: 'secret',
      visibility: 'masked',
      tileCount: 4,
    }
  }))
}
