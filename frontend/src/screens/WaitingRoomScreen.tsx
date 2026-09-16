import type { CommandAcknowledgement, SeatView, Visibility } from '@cg-filipino-mahjong/shared'
import { useRef, useState } from 'react'

import { Button } from '../components/Button.tsx'
import { HandResultPanel } from '../components/HandResultPanel.tsx'
import { PreviewSwitcher } from '../components/PreviewSwitcher.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { RoomDepartureControl } from '../components/RoomDepartureControl.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { ShareRoomLink } from '../components/ShareRoomLink.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import styles from './WaitingRoomScreen.module.css'

const WAITING_COMMANDS = new Set([
  'room.set-visibility',
  'room.configure-seat',
  'room.set-ready',
])

function seatName(seat: SeatView): string {
  if (seat.controller.kind === 'human') return seat.controller.displayName
  return seat.controller.kind === 'bot' ? 'Bot player' : 'Open seat'
}

function seatDetails(seat: SeatView): string {
  if (seat.controller.kind === 'available') return 'Available for another human or a bot.'
  if (seat.controller.kind === 'bot') return 'Automatically ready for every hand.'
  return seat.controller.connection === 'connected'
    ? 'Human · Connected'
    : 'Human · Disconnected and reserved'
}

function seatStatus(seat: SeatView): string {
  if (seat.controller.kind === 'available') return 'Available'
  if (seat.controller.kind === 'bot') return 'Ready'
  if (seat.controller.connection === 'disconnected') return 'Disconnected'
  return seat.controller.ready ? 'Ready' : 'Not ready'
}

function acknowledgementError(acknowledgement: CommandAcknowledgement): string | null {
  return acknowledgement.status === 'rejected' ? acknowledgement.error.message : null
}

export function WaitingRoomScreen({ roomCode }: { readonly roomCode: string }) {
  const { resynchronize, sendCommand } = useRealtimeActions()
  const state = useRealtimeState()
  const {
    connectionStatus,
    isResynchronizing,
    pendingCommands,
    roomSnapshot,
    sessionStatus,
  } = state
  const [actionError, setActionError] = useState<{ readonly roomId: string; readonly message: string } | null>(null)
  const commandInFlight = useRef(false)

  const snapshot = roomSnapshot?.roomCode === roomCode && roomSnapshot.stage !== 'playing'
    ? roomSnapshot
    : null

  if (!snapshot) {
    return (
      <ScreenFrame eyebrow="Waiting room" title="Restoring the table…" description="Waiting for the latest room snapshot.">
        {connectionStatus === 'disconnected'
          ? <Button onClick={resynchronize}>Reconnect</Button>
          : <p role="status">Loading room…</p>}
      </ScreenFrame>
    )
  }

  const waitingMutationPending = Object.values(pendingCommands).some((pending) => (
    pending.roomId === snapshot.roomId && WAITING_COMMANDS.has(pending.type)
  ))
  const commandsDisabled = connectionStatus !== 'connected'
    || sessionStatus !== 'ready'
    || isResynchronizing
    || waitingMutationPending
  const selfSeat = snapshot.seats.find((seat) => seat.seat === snapshot.self.seat)
  const selfHuman = selfSeat?.controller.kind === 'human' ? selfSeat.controller : null
  const humans = snapshot.seats.filter((seat) => seat.controller.kind === 'human')
  const readyHumans = humans.filter((seat) => seat.controller.kind === 'human' && seat.controller.ready)
  const openSeats = snapshot.seats.filter((seat) => seat.controller.kind === 'available')
  const disconnectedHumans = humans.filter((seat) => (
    seat.controller.kind === 'human' && seat.controller.connection === 'disconnected'
  ))

  const runCommand = async (command: Parameters<typeof sendCommand>[0]) => {
    if (commandInFlight.current) return
    commandInFlight.current = true
    setActionError(null)
    try {
      const acknowledgement = await sendCommand(command)
      const message = acknowledgementError(acknowledgement)
      setActionError(message ? { roomId: snapshot.roomId, message } : null)
    } catch (caught) {
      setActionError({
        roomId: snapshot.roomId,
        message: caught instanceof Error ? caught.message : 'The room action could not be completed.',
      })
    } finally {
      commandInFlight.current = false
    }
  }

  const setVisibility = (visibility: Visibility) => {
    if (visibility === snapshot.visibility || commandsDisabled) return
    void runCommand({
      type: 'room.set-visibility',
      roomId: snapshot.roomId,
      expectedRoomRevision: snapshot.roomRevision,
      visibility,
    })
  }

  const configureSeat = (seat: SeatView) => {
    if (seat.controller.kind === 'human' || commandsDisabled) return
    void runCommand({
      type: 'room.configure-seat',
      roomId: snapshot.roomId,
      expectedRoomRevision: snapshot.roomRevision,
      seat: seat.seat,
      controller: seat.controller.kind === 'bot' ? 'available' : 'bot',
    })
  }

  const setReady = () => {
    if (!selfHuman || selfHuman.connection !== 'connected' || commandsDisabled) return
    void runCommand({
      type: 'room.set-ready',
      roomId: snapshot.roomId,
      readinessId: snapshot.readinessId,
      ready: !selfHuman.ready,
    })
  }

  let readinessMessage = `${readyHumans.length} of ${humans.length} humans ready.`
  if (openSeats.length > 0) {
    readinessMessage = `${openSeats.length} ${openSeats.length === 1 ? 'seat is' : 'seats are'} still open. Add bots or wait for players.`
  } else if (disconnectedHumans.length > 0) {
    readinessMessage = `${disconnectedHumans.length} disconnected ${disconnectedHumans.length === 1 ? 'human must' : 'humans must'} return before the hand can start.`
  } else if (readyHumans.length === humans.length) {
    readinessMessage = 'All humans are ready. Waiting for the table to start.'
  }

  const connectionMessage = connectionStatus === 'superseded'
    ? 'This guest session is active in another tab. Room controls are unavailable here.'
    : isResynchronizing || connectionStatus === 'connecting'
      ? 'Restoring the latest room state. Room controls are temporarily unavailable.'
      : 'Connection lost. Room controls are unavailable until you reconnect.'

  return (
    <ScreenFrame
      eyebrow={snapshot.stage === 'between-hands' ? 'Between hands' : 'Waiting room'}
      title={snapshot.stage === 'between-hands' ? 'Ready for another hand?' : 'The table is almost ready.'}
      description="Every seated human has the same controls—there is no host seat."
      actions={<PreviewSwitcher active="waiting" />}
    >
      {connectionStatus !== 'connected' || isResynchronizing ? (
        <div className={styles.connection} role="alert">
          <span>{connectionMessage}</span>
          {connectionStatus === 'disconnected' ? <Button variant="secondary" onClick={resynchronize}>Reconnect</Button> : null}
        </div>
      ) : null}

      {snapshot.stage === 'between-hands' ? <HandResultPanel snapshot={snapshot} /> : null}

      <div className={styles.departure}>
        <p>Leaving releases your seat so you can join another table.</p>
        <RoomDepartureControl roomId={snapshot.roomId} label="Leave room" />
      </div>

      <div className={styles.roomBar}>
        <div className={styles.roomIdentity}>
          <RoomCodeBadge code={roomCode} />
          <ShareRoomLink roomCode={roomCode} />
        </div>
        <fieldset className={styles.visibility} disabled={commandsDisabled} aria-busy={waitingMutationPending}>
          <legend>Room visibility</legend>
          <label>
            <input type="radio" name="room-visibility" checked={snapshot.visibility === 'public'} onChange={() => setVisibility('public')} />
            Public
          </label>
          <label>
            <input type="radio" name="room-visibility" checked={snapshot.visibility === 'unlisted'} onChange={() => setVisibility('unlisted')} />
            Unlisted
          </label>
        </fieldset>
      </div>

      {actionError?.roomId === snapshot.roomId ? <p className={styles.error} role="alert">{actionError.message}</p> : null}

      <div className={styles.seatGrid} aria-label="Four room seats">
        {snapshot.seats.map((seat) => {
          const isMine = seat.seat === snapshot.self.seat
          return (
            <article className={`${styles.seat} ${isMine ? styles.mine : ''}`} key={seat.seat}>
              <span className={styles.seatNumber} aria-hidden="true">{seat.seat + 1}</span>
              <div className={styles.seatCopy}>
                <div className={styles.seatHeading}>
                  <h2>{seatName(seat)}</h2>
                  {isMine ? <span className={styles.you}>You</span> : null}
                </div>
                <p>{seatDetails(seat)}</p>
              </div>
              <span className={`${styles.status} ${seatStatus(seat) === 'Ready' ? styles.ready : ''}`}>{seatStatus(seat)}</span>
              {seat.controller.kind !== 'human' ? (
                <Button
                  className={styles.seatAction}
                  variant="secondary"
                  disabled={commandsDisabled}
                  onClick={() => configureSeat(seat)}
                >
                  {seat.controller.kind === 'bot' ? 'Make available' : 'Add bot'}
                </Button>
              ) : null}
            </article>
          )
        })}
      </div>

      <section className={styles.readiness} aria-labelledby="readiness-title">
        <div>
          <p className={styles.kicker}>Shared start</p>
          <h2 id="readiness-title">Everyone has a say.</h2>
          <p>All four seats must be filled and every connected human must be ready. Bots are always ready.</p>
          <strong className={styles.readinessStatus} role="status" aria-live="polite">{readinessMessage}</strong>
        </div>
        <Button
          disabled={commandsDisabled || !selfHuman || selfHuman.connection !== 'connected'}
          onClick={setReady}
        >
          {waitingMutationPending ? 'Updating…' : selfHuman?.ready ? 'Mark me not ready' : 'I’m ready'}
        </Button>
      </section>
    </ScreenFrame>
  )
}
