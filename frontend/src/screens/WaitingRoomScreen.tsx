import { PreviewSwitcher } from '../components/PreviewSwitcher.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import styles from './WaitingRoomScreen.module.css'

const seats = [
  { position: 'You', state: 'Player details connect in FRONTEND-002' },
  { position: 'Next seat', state: 'Available' },
  { position: 'Across', state: 'Available' },
  { position: 'Previous seat', state: 'Available' },
]

export function WaitingRoomScreen({ roomCode }: { readonly roomCode: string }) {
  return (
    <ScreenFrame
      eyebrow="Waiting room"
      title="The table is almost ready."
      description="Share the room code. Every seated human has the same controls—there is no host seat."
      actions={<PreviewSwitcher active="waiting" />}
    >
      <div className={styles.roomBar}>
        <RoomCodeBadge code={roomCode} />
        <span className={styles.visibility}>Unlisted preview</span>
      </div>
      <div className={styles.seatGrid} aria-label="Four room seats">
        {seats.map((seat, index) => (
          <article className={styles.seat} key={seat.position}>
            <span className={styles.seatNumber} aria-hidden="true">{index + 1}</span>
            <div><h2>{seat.position}</h2><p>{seat.state}</p></div>
            <span className={styles.status}>{index === 0 ? 'Reserved' : 'Open'}</span>
          </article>
        ))}
      </div>
      <aside className={styles.notice}>
        <strong>Foundation preview</strong>
        <span>Realtime seats, bot configuration, and readiness arrive in later tickets.</span>
      </aside>
    </ScreenFrame>
  )
}
