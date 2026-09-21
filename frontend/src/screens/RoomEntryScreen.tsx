import type { RoomCode, RoomEntrySeat, RoomEntrySummary, RoomUnavailable, Seat } from '@cg-filipino-mahjong/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '../components/Button.tsx'
import { GuestNameForm } from '../components/GuestNameForm.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { RoomDepartureControl } from '../components/RoomDepartureControl.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { RealtimeCommandError, useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import styles from './RoomEntryScreen.module.css'

function stageLabel(status: RoomEntrySummary['status']): string {
  if (status === 'between-hands') return 'The room is between hands.'
  return status === 'playing' ? 'A hand is in progress.' : 'The room is gathering players.'
}

function seatLabel(seat: RoomEntrySeat): string {
  if (seat.kind === 'human') return seat.displayName
  return seat.kind === 'bot' ? 'Bot player' : 'Open seat'
}

function seatDetail(seat: RoomEntrySeat): string {
  if (seat.kind === 'human') return seat.connection === 'connected' ? 'Connected' : 'Disconnected · reserved'
  if (seat.kind === 'bot') return seat.takeoverAvailable ? 'Available for takeover' : 'Takeover pending'
  return 'Available to join'
}

const ROSTER_CHANGE_ERRORS = new Set(['room-full', 'seat-unavailable', 'takeover-pending', 'invalid-room-state'])

function terminalError(caught: unknown): RoomUnavailable | null {
  if (!(caught instanceof RealtimeCommandError) || caught.issue.kind !== 'server') return null
  const { code, message } = caught.issue.error
  return code === 'room-expired' || code === 'room-not-found' ? { code, message } : null
}

export function RoomEntryScreen({ roomCode }: { readonly roomCode: RoomCode }) {
  const { clearIssue, inspectRoom, resynchronize, sendCommand } = useRealtimeActions()
  const state = useRealtimeState()
  const [entry, setEntry] = useState<RoomEntrySummary | null>(null)
  const [inspectionRevision, setInspectionRevision] = useState(0)
  const [error, setError] = useState('')
  const [localRoomError, setLocalRoomError] = useState<RoomUnavailable | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingTakeoverSeat, setPendingTakeoverSeat] = useState<Seat | null>(null)
  const [takeoverNotice, setTakeoverNotice] = useState('')
  const inspectionKey = useRef<string | null>(null)
  const requestGeneration = useRef(0)
  const activeCommand = useRef(false)
  const { connectionStatus, hasReceivedLobby, roomError, roomSnapshot, sessionId, sessionStatus } = state
  const ownReservation = roomSnapshot?.roomCode === roomCode
    ? roomSnapshot.takeoverReservations.find((reservation) => reservation.isMine)
    : undefined
  const currentContext = useRef({ roomCode, connectionStatus, roomError, ownReservation })
  useEffect(() => {
    currentContext.current = { roomCode, connectionStatus, roomError, ownReservation }
  }, [roomCode, connectionStatus, roomError, ownReservation])
  const isCurrentRequest = useCallback((generation: number, requestedRoom: RoomCode, allowReservation = false) => (
    requestGeneration.current === generation
    && currentContext.current.roomCode === requestedRoom
    && currentContext.current.connectionStatus === 'connected'
    && !currentContext.current.roomError
    && (allowReservation || !currentContext.current.ownReservation)
  ), [])

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      requestGeneration.current += 1
      inspectionKey.current = null
      activeCommand.current = false
      // Reset local inspection data when the authoritative connection becomes unusable.
      // oxlint-disable-next-line react/set-state-in-effect
      setEntry(null)
    }
  }, [connectionStatus])

  useEffect(() => {
    if (!roomError) return
    requestGeneration.current += 1
    inspectionKey.current = null
    activeCommand.current = false
    // A terminal authoritative error invalidates every pending local entry-flow value.
    // oxlint-disable-next-line react/set-state-in-effect
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
    void inspectRoom(roomCode).then((nextEntry) => {
      if (!isCurrentRequest(generation, roomCode)) return
      setEntry(nextEntry)
      setSubmitting(false)
      activeCommand.current = false
      if (pendingTakeoverSeat !== null) {
        setTakeoverNotice('Your previous takeover request was canceled. Choose from the seats that are currently available.')
        setPendingTakeoverSeat(null)
      }
    }).catch((caught: unknown) => {
      if (!isCurrentRequest(generation, roomCode)) return
      const unavailable = terminalError(caught)
      if (unavailable) {
        requestGeneration.current += 1
        setLocalRoomError(unavailable)
        setPendingTakeoverSeat(null)
        setTakeoverNotice('')
      } else {
        setError(caught instanceof Error ? caught.message : 'The room could not be checked.')
      }
      setSubmitting(false)
      activeCommand.current = false
      setEntry(null)
    })
  }, [connectionStatus, error, hasReceivedLobby, inspectRoom, inspectionRevision, isCurrentRequest, localRoomError, ownReservation, pendingTakeoverSeat, roomCode, roomError, sessionId, sessionStatus])

  const retryInspection = () => {
    requestGeneration.current += 1
    activeCommand.current = false
    if (roomError || localRoomError) setPendingTakeoverSeat(null)
    clearIssue()
    inspectionKey.current = null
    setEntry(null)
    setError('')
    setLocalRoomError(null)
    setSubmitting(false)
    setTakeoverNotice('')
  }

  const enterRoom = async (seat?: Seat) => {
    if (activeCommand.current || submitting || pendingTakeoverSeat !== null || ownReservation
      || connectionStatus !== 'connected' || sessionStatus !== 'ready' || state.isResynchronizing) return
    activeCommand.current = true
    const generation = ++requestGeneration.current
    setSubmitting(true)
    setError('')
    setTakeoverNotice('')
    try {
      const acknowledgement = await sendCommand(seat === undefined
        ? { type: 'room.join', roomCode }
        : { type: 'room.takeover', roomCode, seat })
      if (!isCurrentRequest(generation, roomCode, true)) return
      if (acknowledgement.status === 'rejected') {
        const rosterChanged = ROSTER_CHANGE_ERRORS.has(acknowledgement.error.code)
        if (acknowledgement.error.code === 'room-expired' || acknowledgement.error.code === 'room-not-found') {
          setLocalRoomError({ code: acknowledgement.error.code, message: acknowledgement.error.message })
        } else if (rosterChanged) {
          setTakeoverNotice(acknowledgement.error.message)
        } else {
          setError(acknowledgement.error.message)
        }
        setSubmitting(false)
        activeCommand.current = false
        inspectionKey.current = null
        setEntry(null)
        setPendingTakeoverSeat(null)
        if (rosterChanged) {
          setInspectionRevision((revision) => revision + 1)
        }
      } else if (acknowledgement.result.kind === 'takeover-pending' && seat !== undefined) {
        setPendingTakeoverSeat(seat)
        activeCommand.current = false
      }
    } catch (caught) {
      if (!isCurrentRequest(generation, roomCode, true)) return
      const unavailable = terminalError(caught)
      if (unavailable) setLocalRoomError(unavailable)
      else setError(caught instanceof Error ? caught.message : 'The room could not be entered.')
      setSubmitting(false)
      activeCommand.current = false
      inspectionKey.current = null
      setEntry(null)
    }
  }

  if (sessionStatus === 'anonymous') {
    return (
      <ScreenFrame title={`Join room ${roomCode}`}>
        <GuestNameForm />
      </ScreenFrame>
    )
  }

  if (sessionStatus === 'superseded') {
    return <ScreenFrame title="This guest is active in another tab." description="Continue from the newer connection." />
  }

  const unavailable = roomError ?? localRoomError
  if (unavailable) {
    return (
      <ScreenFrame title={unavailable.code === 'room-expired' ? 'This room has expired.' : 'This room was not found.'} description={unavailable.message}>
        <div className={styles.buttonRow}><Button onClick={retryInspection}>Check again</Button><Link className={styles.link} to="/">Return to lobby</Link></div>
      </ScreenFrame>
    )
  }

  if (connectionStatus === 'disconnected') {
    return (
      <ScreenFrame title="We couldn’t check this room." description="Reconnect to try again.">
        <div className={styles.buttonRow}><Button onClick={resynchronize}>Reconnect</Button><Link className={styles.link} to="/">Return to lobby</Link></div>
      </ScreenFrame>
    )
  }

  if (error && !ownReservation) {
    return (
      <ScreenFrame title="We couldn’t enter this room." description={error}>
        <div className={styles.buttonRow}><Button onClick={retryInspection}>Check again</Button><Link className={styles.link} to="/">Return to lobby</Link></div>
      </ScreenFrame>
    )
  }

  const deferredTakeoverSeat = ownReservation?.seat ?? pendingTakeoverSeat
  if (deferredTakeoverSeat !== null && deferredTakeoverSeat !== undefined && !roomSnapshot?.self.canControl) {
    return (
      <ScreenFrame title={`Waiting to take over seat ${deferredTakeoverSeat + 1}`} description="Control transfers after the current claims finish.">
        <div className={styles.panel}>
          <RoomCodeBadge code={roomCode} />
          <span role="status">Takeover requested</span>
          {roomSnapshot?.roomCode === roomCode ? (
            <RoomDepartureControl
              roomId={roomSnapshot.roomId}
              label="Cancel takeover"
              onDetached={() => { setPendingTakeoverSeat(null); setSubmitting(false); setTakeoverNotice('') }}
            />
          ) : null}
        </div>
      </ScreenFrame>
    )
  }

  if (sessionStatus === 'restoring' || !hasReceivedLobby || !entry) {
    return (
      <ScreenFrame title="Finding an open chair…">
        <div className={styles.panel}><RoomCodeBadge code={roomCode} /></div>
      </ScreenFrame>
    )
  }

  const canJoinNormally = entry.status !== 'playing' && entry.availableSeatCount > 0
  const canTakeover = entry.takeoverSeats.length > 0
  const isFull = !canJoinNormally && !canTakeover
  const admissionDisabled = submitting || connectionStatus !== 'connected' || sessionStatus !== 'ready'
    || state.isResynchronizing || Boolean(ownReservation)

  return (
    <ScreenFrame title={isFull ? 'There isn’t an open chair.' : 'Choose how to join.'}>
      <div className={styles.panel}>
        <div className={styles.summary}><RoomCodeBadge code={entry.roomCode} /><span>{stageLabel(entry.status)}</span><span>{entry.humanCount}/4 humans</span><span>{entry.availableSeatCount} open seats</span>{entry.isPaused ? <strong>Paused</strong> : null}</div>
        {takeoverNotice ? <p className={styles.notice} role="status">{takeoverNotice}</p> : null}
        <section className={styles.roster} aria-label="Current room roster">
          <h2>At the table</h2>
          <ol className={styles.seatList}>
            {entry.seats.map((seat) => (
              <li className={styles.seat} key={seat.seat}>
                <span className={styles.seatNumber} aria-hidden="true">{seat.seat + 1}</span>
                <span className={styles.seatCopy}><strong>{seatLabel(seat)}</strong><small>{seatDetail(seat)}</small></span>
              </li>
            ))}
          </ol>
        </section>
        {canJoinNormally ? <Button disabled={admissionDisabled} onClick={() => void enterRoom()}>{submitting ? 'Joining…' : 'Join an open seat'}</Button> : null}
        {canTakeover ? (
          <fieldset className={styles.takeovers} disabled={admissionDisabled}>
            <legend>Available bot seats</legend>
            <div className={styles.buttonRow}>{entry.takeoverSeats.map((seat) => <Button key={seat} variant="secondary" onClick={() => void enterRoom(seat)}>Take over seat {seat + 1}</Button>)}</div>
          </fieldset>
        ) : null}
        {isFull ? <p role="status">This room has no open human seat or available bot takeover.</p> : null}
        <Link className={styles.link} to="/">Return to lobby</Link>
      </div>
    </ScreenFrame>
  )
}
