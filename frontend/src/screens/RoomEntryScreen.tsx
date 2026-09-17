import type { RoomCode, RoomEntrySummary, RoomUnavailable, Seat } from '@cg-filipino-mahjong/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '../components/Button.tsx'
import { GuestNameForm } from '../components/GuestNameForm.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { RealtimeCommandError, useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import styles from './RoomEntryScreen.module.css'

function stageLabel(status: RoomEntrySummary['status']): string {
  if (status === 'between-hands') return 'The room is between hands.'
  return status === 'playing' ? 'A hand is in progress.' : 'The room is gathering players.'
}

function terminalError(caught: unknown): RoomUnavailable | null {
  if (!(caught instanceof RealtimeCommandError) || caught.issue.kind !== 'server') return null
  const { code, message } = caught.issue.error
  return code === 'room-expired' || code === 'room-not-found' ? { code, message } : null
}

export function RoomEntryScreen({ roomCode }: { readonly roomCode: RoomCode }) {
  const { clearIssue, inspectRoom, resynchronize, sendCommand } = useRealtimeActions()
  const state = useRealtimeState()
  const [entry, setEntry] = useState<RoomEntrySummary | null>(null)
  const [error, setError] = useState('')
  const [localRoomError, setLocalRoomError] = useState<RoomUnavailable | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingTakeoverSeat, setPendingTakeoverSeat] = useState<Seat | null>(null)
  const [takeoverNotice, setTakeoverNotice] = useState('')
  const inspectionKey = useRef<string | null>(null)
  const requestGeneration = useRef(0)
  const { connectionStatus, hasReceivedLobby, roomError, roomSnapshot, sessionId, sessionStatus } = state
  const ownReservation = roomSnapshot?.roomCode === roomCode
    ? roomSnapshot.takeoverReservations.find((reservation) => reservation.isMine)
    : undefined

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      inspectionKey.current = null
      requestGeneration.current += 1
    }
  }, [connectionStatus])

  useEffect(() => {
    if (!roomError) return
    requestGeneration.current += 1
    inspectionKey.current = null
    setEntry(null)
    setError('')
    setLocalRoomError(null)
    setSubmitting(false)
    setPendingTakeoverSeat(null)
    setTakeoverNotice('')
  }, [roomError])

  useEffect(() => {
    if (
      sessionStatus !== 'ready'
      || connectionStatus !== 'connected'
      || !hasReceivedLobby
      || ownReservation
      || roomError
      || localRoomError
      || error
      || !sessionId
    ) return
    const key = `${sessionId}:${roomCode}`
    if (inspectionKey.current === key) return
    inspectionKey.current = key
    const generation = ++requestGeneration.current
    setError('')
    void inspectRoom(roomCode).then((nextEntry) => {
      if (requestGeneration.current !== generation) return
      setEntry(nextEntry)
      if (pendingTakeoverSeat !== null) {
        setTakeoverNotice('Your previous takeover request was canceled. Choose from the seats that are currently available.')
        setPendingTakeoverSeat(null)
        setSubmitting(false)
      }
    }).catch((caught: unknown) => {
      if (requestGeneration.current !== generation) return
      const unavailable = terminalError(caught)
      if (unavailable) {
        requestGeneration.current += 1
        setLocalRoomError(unavailable)
        setPendingTakeoverSeat(null)
        setSubmitting(false)
        setEntry(null)
        setTakeoverNotice('')
        return
      }
      setError(caught instanceof Error ? caught.message : 'The room could not be checked.')
    })
  }, [connectionStatus, error, hasReceivedLobby, inspectRoom, localRoomError, ownReservation, pendingTakeoverSeat, roomCode, roomError, sessionId, sessionStatus])

  const retryInspection = () => {
    requestGeneration.current += 1
    clearIssue()
    inspectionKey.current = null
    setEntry(null)
    setError('')
    setLocalRoomError(null)
    setSubmitting(false)
    setPendingTakeoverSeat(null)
    setTakeoverNotice('')
  }

  const enterRoom = async (seat?: Seat) => {
    const generation = ++requestGeneration.current
    setSubmitting(true)
    setError('')
    setTakeoverNotice('')
    try {
      const acknowledgement = await sendCommand(seat === undefined
        ? { type: 'room.join', roomCode }
        : { type: 'room.takeover', roomCode, seat })
      if (requestGeneration.current !== generation) return
      if (acknowledgement.status === 'rejected') {
        if (acknowledgement.error.code === 'room-expired' || acknowledgement.error.code === 'room-not-found') {
          setLocalRoomError({ code: acknowledgement.error.code, message: acknowledgement.error.message })
        } else {
          setError(acknowledgement.error.message)
        }
        setSubmitting(false)
        inspectionKey.current = null
        setEntry(null)
        setPendingTakeoverSeat(null)
      } else if (acknowledgement.result.kind === 'takeover-pending' && seat !== undefined) {
        setPendingTakeoverSeat(seat)
      }
    } catch (caught) {
      if (requestGeneration.current !== generation) return
      const unavailable = terminalError(caught)
      if (unavailable) setLocalRoomError(unavailable)
      else setError(caught instanceof Error ? caught.message : 'The room could not be entered.')
      setSubmitting(false)
      setPendingTakeoverSeat(null)
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

  const unavailable = roomError ?? localRoomError
  if (unavailable) {
    return (
      <ScreenFrame eyebrow="Room unavailable" title={unavailable.code === 'room-expired' ? 'This room has expired.' : 'This room was not found.'} description={unavailable.message}>
        <div className={styles.buttonRow}><Button onClick={retryInspection}>Check again</Button><Link className={styles.link} to="/">Return to lobby</Link></div>
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

  const deferredTakeoverSeat = ownReservation?.seat ?? pendingTakeoverSeat
  if (deferredTakeoverSeat !== null && deferredTakeoverSeat !== undefined && !roomSnapshot?.self.canControl) {
    return (
      <ScreenFrame eyebrow="Takeover requested" title="Finishing the current claims…" description="The bot will complete its required response before control transfers. No private seat state is shown until admission.">
        <div className={styles.panel}><RoomCodeBadge code={roomCode} /><p role="status">Waiting to take over seat {deferredTakeoverSeat + 1}.</p></div>
      </ScreenFrame>
    )
  }

  if (error) {
    return (
      <ScreenFrame eyebrow="Room unavailable" title="We couldn’t enter this room." description={error}>
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
  const canTakeover = entry.takeoverSeats.length > 0
  const isFull = !canJoinNormally && !canTakeover

  return (
    <ScreenFrame eyebrow="Room entry" title={isFull ? 'There isn’t an open chair.' : 'Choose how to join.'} description={stageLabel(entry.status)}>
      <div className={styles.panel}>
        <div className={styles.summary}><RoomCodeBadge code={entry.roomCode} /><span>{entry.humanCount}/4 humans</span><span>{entry.availableSeatCount} open seats</span>{entry.isPaused ? <strong>Paused</strong> : null}</div>
        {takeoverNotice ? <p className={styles.notice} role="status">{takeoverNotice}</p> : null}
        {canJoinNormally ? <Button disabled={submitting} onClick={() => void enterRoom()}>{submitting ? 'Joining…' : 'Join an open seat'}</Button> : null}
        {canTakeover ? (
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
