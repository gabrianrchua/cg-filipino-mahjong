import type { Seat } from '@cg-filipino-mahjong/shared'

export function botDisplayName(seat: Seat): string {
  return `Bot ${seat + 1}`
}
