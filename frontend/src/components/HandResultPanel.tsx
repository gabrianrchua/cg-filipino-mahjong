import type { BetweenHandsSnapshot, Seat } from '@cg-filipino-mahjong/shared'

import { MahjongTile } from './MahjongTile.tsx'
import { tileLabel } from './tileLabels.ts'
import styles from './HandResultPanel.module.css'

const GROUP_LABELS = {
  pair: 'Pair',
  chow: 'Chow',
  pong: 'Pong',
  kang: 'Káng',
} as const

function seatName(snapshot: BetweenHandsSnapshot, seat: Seat): string {
  const controller = snapshot.seats[seat]?.controller
  if (controller?.kind === 'human') return controller.displayName
  if (controller?.kind === 'bot') return `Bot in seat ${seat + 1}`
  return `Seat ${seat + 1}`
}

export function HandResultPanel({ snapshot }: { readonly snapshot: BetweenHandsSnapshot }) {
  const result = snapshot.result
  const nextDealer = seatName(snapshot, result.nextDealerSeat)

  if (result.kind === 'exhaustion-draw') {
    return (
      <section className={styles.result} aria-labelledby="hand-result-title">
        <h2 id="hand-result-title">The wall is exhausted.</h2>
        <p className={styles.dealer}><strong>Next dealer</strong><span>{nextDealer}</span></p>
      </section>
    )
  }

  if (result.kind === 'abort') {
    return (
      <section className={styles.result} aria-labelledby="hand-result-title">
        <h2 id="hand-result-title">The hand was aborted.</h2>
        <p className={styles.dealer}><strong>Dealer remains</strong><span>{nextDealer}</span></p>
      </section>
    )
  }

  const winner = seatName(snapshot, result.winnerSeat)
  const source = result.source === 'self-draw' ? 'by self-draw' : 'on a discard'
  const handType = result.decomposition.kind === 'regular' ? 'Regular hand' : 'Seven pairs plus a pong'

  return (
    <section className={styles.result} aria-labelledby="hand-result-title">
      <h2 id="hand-result-title">{winner} wins {source}.</h2>
      <div className={styles.winSummary}>
        <div className={styles.winningTile}>
          <span>Winning tile</span>
          <MahjongTile tile={result.winningTile} />
          <strong>{tileLabel(result.winningTile)}</strong>
        </div>
        <div className={styles.outcomeDetails}>
          <p><strong>Hand type</strong><span>{handType}</span></p>
          <p><strong>Next dealer</strong><span>{nextDealer}</span></p>
        </div>
      </div>
      <div className={styles.decomposition}>
        <h3>Winning decomposition</h3>
        <ol className={styles.groups}>
          {result.decomposition.groups.map((group, index) => {
            const label = GROUP_LABELS[group.kind]
            const tiles = group.tiles.map(tileLabel).join(', ')
            return (
              <li className={styles.group} aria-label={`${label}: ${tiles}`} key={`${group.kind}-${index}`}>
                <span>{label}</span>
                <div className={styles.tileRow} aria-hidden="true">
                  {group.tiles.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
