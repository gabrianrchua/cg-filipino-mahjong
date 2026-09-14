import type { RoomCode, RoomEntrySummary, Seat } from '@cg-filipino-mahjong/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '../components/Button.tsx'
import { GuestNameForm } from '../components/GuestNameForm.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import styles from './RoomEntryScreen.module.css'

function stageLabel(status: RoomEntrySummary['status']): string {
  if (status === 'between-hands') return 'The room is between hands.'
  return status === 'playing' ? 'A hand is in progress.' : 'The room is gathering players.'
}

export function RoomEntryScreen({ roomCode }: { readonly roomCode: RoomCode }) {
  const { clearIssue, inspectRoom, resynchronize, sendCommand } = useRealtimeActions()
  const state = useRealtimeState()
  const [entry, setEntry] = useState<RoomEntrySummary | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inspectionKey = useRef<string | null>(null)
  const { connectionStatus, hasReceivedLobby, roomError, roomSnapshot, sessionId, sessionStatus } = state
  const ownReservation = roomSnapshot?.roomCode === roomCode
    ? roomSnapshot.takeoverReservations.find((reservation) => reservation.isMine)
    : undefined

  useEffect(() => {
    if (
      sessionStatus !== 'ready'
      || connectionStatus !== 'connected'
      || !hasReceivedLobby
      || roomSnapshot
      || roomError
      || error
      || !sessionId
    ) return
    const key = `${sessionId}:${roomCode}`
    if (inspectionKey.current === key) return
    inspectionKey.current = key
    setError('')
    void inspectRoom(roomCode).then(setEntry).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'The room could not be checked.')
    })
  }, [connectionStatus, error, hasReceivedLobby, inspectRoom, roomCode, roomError, roomSnapshot, sessionId, sessionStatus])

  const retryInspection = () => {
    clearIssue()
    inspectionKey.current = null
    setEntry(null)
    setError('')
  }

  const enterRoom = async (seat?: Seat) => {
    setSubmitting(true)
    setError('')
    try {
      const acknowledgement = await sendCommand(seat === undefined
        ? { type: 'room.join', roomCode }
        : { type: 'room.takeover', roomCode, seat })
      if (acknowledgement.status === 'rejected') {
        setError(acknowledgement.error.message)
        setSubmitting(false)
        inspectionKey.current = null
        setEntry(null)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The room could not be entered.')
      setSubmitting(false)
    }
  }

  if (sessionStatus === 'anonymous') {
    return (
      <ScreenFrame eyebrow="Room invitation" title="One name, then you’re in." description={`Your invitation to room ${roomCode} will stay here while your guest session is created.`}>
        <GuestNameForm description="Choose the name your tablemates will see. Your room invitation will continue automatically." />
      </ScreenFrame>
    )
  }

  if (sessionStatus === 'superseded') {
    return <ScreenFrame eyebrow="Session moved" title="This guest is active in another tab." description="Continue from the newer connection." />
  }

  if (ownReservation && !roomSnapshot?.self.canControl) {
    return (
      <ScreenFrame eyebrow="Takeover requested" title="Finishing the current claims…" description="The bot will complete its required response before control transfers. No private seat state is shown until admission.">
        <div className={styles.panel}><RoomCodeBadge code={roomCode} /><p role="status">Waiting to take over seat {ownReservation.seat + 1}.</p></div>
      </ScreenFrame>
    )
  }

  if (connectionStatus === 'disconnected') {
    return (
      <ScreenFrame eyebrow="Connection lost" title="We couldn’t check this room." description="Reconnect to restore your guest session and room intent.">
        <div className={styles.buttonRow}><Button onClick={resynchronize}>Reconnect</Button><Link className={styles.link} to="/">Return to lobby</Link></div>
      </ScreenFrame>
    )
  }

  const unavailableMessage = roomError?.message || error
  if (unavailableMessage) {
    return (
      <ScreenFrame eyebrow="Room unavailable" title={roomError?.code === 'room-expired' ? 'This room has expired.' : 'We couldn’t enter this room.'} description={unavailableMessage}>
        <div className={styles.buttonRow}><Button onClick={retryInspection}>Check again</Button><Link className={styles.link} to="/">Return to lobby</Link></div>
      </ScreenFrame>
    )
  }

  if (sessionStatus === 'restoring' || !hasReceivedLobby || !entry) {
    return (
      <ScreenFrame eyebrow="Checking room" title="Finding an open chair…" description="Checking the latest room status before requesting admission.">
        <div className={styles.panel}><RoomCodeBadge code={roomCode} /><p role="status">Loading room…</p></div>
      </ScreenFrame>
    )
  }

  const canJoinNormally = entry.status !== 'playing' && entry.availableSeatCount > 0
  const takeoverOnly = !canJoinNormally && entry.takeoverSeats.length > 0
  const isFull = !canJoinNormally && entry.takeoverSeats.length === 0

  return (
    <ScreenFrame eyebrow="Room entry" title={isFull ? 'There isn’t an open chair.' : 'Choose how to join.'} description={stageLabel(entry.status)}>
      <div className={styles.panel}>
        <div className={styles.summary}><RoomCodeBadge code={entry.roomCode} /><span>{entry.humanCount}/4 humans</span><span>{entry.availableSeatCount} open seats</span>{entry.isPaused ? <strong>Paused</strong> : null}</div>
        {canJoinNormally ? <Button disabled={submitting} onClick={() => void enterRoom()}>{submitting ? 'Joining…' : 'Join an open seat'}</Button> : null}
        {takeoverOnly ? (
          <fieldset className={styles.takeovers} disabled={submitting}>
            <legend>Available bot seats</legend>
            <p>Control transfers without revealing the bot’s hand until the server admits you.</p>
            <div className={styles.buttonRow}>{entry.takeoverSeats.map((seat) => <Button key={seat} variant="secondary" onClick={() => void enterRoom(seat)}>Take over seat {seat + 1}</Button>)}</div>
          </fieldset>
        ) : null}
        {isFull ? <p role="status">This room has no open human seat or available bot takeover.</p> : null}
        <Link className={styles.link} to="/">Return to lobby</Link>
      </div>
    </ScreenFrame>
  )
}
