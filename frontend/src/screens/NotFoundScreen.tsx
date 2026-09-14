import { Link } from 'react-router-dom'

import { ScreenFrame } from '../components/ScreenFrame.tsx'
import styles from './NotFoundScreen.module.css'

export function NotFoundScreen({ roomCode }: { readonly roomCode?: string }) {
  return (
    <ScreenFrame
      eyebrow="That path is unavailable"
      title={roomCode ? 'Check the room code.' : 'This tile is off the table.'}
      description={roomCode
        ? 'Room codes contain six letters or numbers and omit easily confused characters.'
        : 'The page you requested does not exist.'}
    >
      <Link className={styles.homeLink} to="/">Return to the lobby</Link>
    </ScreenFrame>
  )
}
