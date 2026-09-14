import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '../components/Button.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { parseRoomCodeRoute } from '../routes.ts'
import styles from './LobbyScreen.module.css'

export function LobbyScreen() {
  const navigate = useNavigate()
  const roomCodeId = useId()
  const errorId = useId()
  const [roomCode, setRoomCode] = useState('')
  const [error, setError] = useState('')

  const joinRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = parseRoomCodeRoute(roomCode)
    if (!parsed.ok) {
      setError('Enter the six-character code from your invitation.')
      return
    }
    navigate(`/room/${parsed.roomCode}`)
  }

  return (
    <ScreenFrame
      eyebrow="A familiar game, wherever you are"
      title="Mahjong, made for the whole table."
      description="Gather four seats for fast, social Filipino Mahjong. No account required."
    >
      <div className={styles.layout}>
        <form className={styles.joinCard} onSubmit={joinRoom} noValidate>
          <div>
            <p className={styles.kicker}>Have an invitation?</p>
            <h2>Join by room code</h2>
            <p className={styles.help}>Room codes use six letters and numbers.</p>
          </div>
          <div className={styles.field}>
            <label htmlFor={roomCodeId}>Room code</label>
            <div className={styles.inputRow}>
              <input
                id={roomCodeId}
                name="roomCode"
                value={roomCode}
                onChange={(event) => {
                  setRoomCode(event.target.value.toUpperCase())
                  if (error) setError('')
                }}
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="off"
                autoCapitalize="characters"
                inputMode="text"
                maxLength={6}
                placeholder="MJ2345"
              />
              <Button type="submit">Join room</Button>
            </div>
            {error ? <p className={styles.error} id={errorId} role="alert">{error}</p> : null}
          </div>
        </form>

        <aside className={styles.foundation} aria-labelledby="foundation-title">
          <p className={styles.tileMotif} aria-hidden="true"><span>五</span><span>●</span><span>竹</span></p>
          <h2 id="foundation-title">Settle in. We’ll handle the wall.</h2>
          <ul>
            <li>Four fixed seats</li>
            <li>Automatic flowers and gifts</li>
            <li>Explicit claims and wins</li>
          </ul>
          <p className={styles.comingSoon}>Guest names and room creation arrive in the next lobby ticket.</p>
        </aside>
      </div>
    </ScreenFrame>
  )
}
