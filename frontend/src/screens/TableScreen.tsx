import { PreviewSwitcher } from '../components/PreviewSwitcher.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import styles from './TableScreen.module.css'

function Opponent({ className, name, detail }: { readonly className: string; readonly name: string; readonly detail: string }) {
  return (
    <section className={`${styles.opponent} ${className}`} aria-label={`${name}, ${detail}`}>
      <span className={styles.avatar} aria-hidden="true">{name.slice(0, 1)}</span>
      <span><strong>{name}</strong><small>{detail}</small></span>
      <span className={styles.miniTiles} aria-hidden="true"><i /><i /><i /><i /></span>
    </section>
  )
}

function TileBack({ number }: { readonly number: number }) {
  return (
    <span className={styles.tile} aria-hidden="true" data-tile-number={number}>
      <svg viewBox="0 0 32 44">
        <rect x="1" y="1" width="30" height="40" rx="3.5" fill="currentColor" stroke="rgba(255,255,255,.42)" />
        <path d="M8 10h16v20H8zM11 13l10 14M21 13L11 27" fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="1.5" />
        <path d="M4 41h24" stroke="#c9d1ce" strokeWidth="4" />
      </svg>
    </span>
  )
}

export function TableScreen({ roomCode }: { readonly roomCode: string }) {
  return (
    <ScreenFrame tone="table" eyebrow="Table preview" title="Everything has its place."
      description="The local hand stays readable and scrolls on smaller screens instead of squeezing every tile."
      actions={<PreviewSwitcher active="table" />}>
      <div className={styles.meta}><RoomCodeBadge code={roomCode} /><span>71 tiles in wall</span></div>
      <div className={styles.table} aria-label="Mahjong table with four seats">
        <Opponent className={styles.across} name="Maya" detail="Across · 16 concealed" />
        <Opponent className={styles.previous} name="Luz" detail="Previous · 13 concealed" />
        <div className={styles.center}><span>Latest discard</span><strong aria-label="Nine of characters">九</strong><small>Waiting for responses</small></div>
        <Opponent className={styles.next} name="Noel" detail="Next · 16 concealed" />
        <section className={styles.localSeat} aria-label="Your seat, dealer"><span className={styles.dealer}>Dealer</span><strong>You</strong><small>Your turn</small></section>
      </div>
      <section className={styles.handSection} aria-labelledby="hand-title">
        <div className={styles.handHeading}><div><h2 id="hand-title">Your hand</h2><p>17 tiles · horizontal scroll on compact screens</p></div><span>Arrange controls arrive in FRONTEND-006</span></div>
        <div className={styles.rack} role="img" aria-label="Preview of a seventeen-tile concealed hand">
          <div className={styles.tiles} data-testid="tile-rack">
            {Array.from({ length: 17 }, (_, index) => <TileBack key={index} number={index + 1} />)}
          </div>
        </div>
      </section>
    </ScreenFrame>
  )
}
