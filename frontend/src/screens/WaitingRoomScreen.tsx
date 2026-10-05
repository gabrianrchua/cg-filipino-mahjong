import type { CommandAcknowledgement, RoomCode, SeatView, Visibility } from '@cg-filipino-mahjong/shared'
import { useRef, useState } from 'react'

import { Button } from '../components/Button.tsx'
import { HandResultPanel } from '../components/HandResultPanel.tsx'
import { botDisplayName } from '../components/playerPresentation.ts'
import { PreviewSwitcher } from '../components/PreviewSwitcher.tsx'
import { RoomDepartureControl } from '../components/RoomDepartureControl.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { hasPendingRoomMembershipCommand } from '../realtime/state.ts'
import styles from './WaitingRoomScreen.module.css'

const WAITING_COMMANDS = new Set([
  'room.set-visibility',
  'room.configure-seat',
  'room.set-ready',
])

function seatName(seat: SeatView): string {
  if (seat.controller.kind === 'human') return seat.controller.displayName
  return seat.controller.kind === 'bot' ? botDisplayName(seat.seat) : 'Open seat'
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

export function WaitingRoomScreen({ roomCode }: { readonly roomCode: RoomCode }) {
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
      <ScreenFrame title="Restoring the table…">
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
    || hasPendingRoomMembershipCommand(pendingCommands)
  const selfSeat = snapshot.seats.find((seat) => seat.seat === snapshot.self.seat)
  const isPlayer = snapshot.self.role === 'player' && snapshot.self.canControl
  const isSpectator = snapshot.self.role === 'spectator'
  const selfHuman = selfSeat?.controller.kind === 'human' ? selfSeat.controller : null
  const humans = snapshot.seats.filter((seat) => seat.controller.kind === 'human')
  const readyHumans = humans.filter((seat) => seat.controller.kind === 'human' && seat.controller.ready)
  const openSeats = snapshot.seats.filter((seat) => seat.controller.kind === 'available')
  const disconnectedHumans = humans.filter((seat) => (
    seat.controller.kind === 'human' && seat.controller.connection === 'disconnected'
  ))
  const reservedTakeoverSeats = new Set(snapshot.takeoverReservations.map((reservation) => reservation.seat))
  const availableBotSeats = snapshot.seats.filter((seat) => (
    seat.controller.kind === 'bot' && !reservedTakeoverSeats.has(seat.seat)
  ))
  const ownReservation = snapshot.takeoverReservations.find((reservation) => reservation.isMine)
  const promotionDisabled = commandsDisabled || Boolean(ownReservation)

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

  const joinOpenSeat = () => {
    if (!isSpectator || promotionDisabled || openSeats.length === 0) return
    void runCommand({ type: 'room.join', roomCode })
  }

  const takeOverBot = (seat: SeatView) => {
    if (!isSpectator || promotionDisabled || seat.controller.kind !== 'bot') return
    void runCommand({ type: 'room.takeover', roomCode, seat: seat.seat })
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
      title={snapshot.stage === 'between-hands' ? 'Ready for another hand?' : 'Waiting room'}
      actions={<PreviewSwitcher active="waiting" />}
    >
      {connectionStatus !== 'connected' || isResynchronizing ? (
        <div className={styles.connection} role="alert">
          <span>{connectionMessage}</span>
          {connectionStatus === 'disconnected' ? <Button variant="secondary" onClick={resynchronize}>Reconnect</Button> : null}
        </div>
      ) : null}

      {snapshot.stage === 'between-hands' ? <HandResultPanel snapshot={snapshot} /> : null}

      <div className={styles.roomBar}>
        {isPlayer ? <fieldset className={styles.visibility} disabled={commandsDisabled} aria-busy={waitingMutationPending}>
          <legend>Room visibility</legend>
          <label>
            <input type="radio" name="room-visibility" checked={snapshot.visibility === 'public'} onChange={() => setVisibility('public')} />
            Public
          </label>
          <label>
            <input type="radio" name="room-visibility" checked={snapshot.visibility === 'unlisted'} onChange={() => setVisibility('unlisted')} />
            Unlisted
          </label>
        </fieldset> : null}
        <RoomDepartureControl roomId={snapshot.roomId} label={isSpectator ? 'Stop spectating' : 'Leave room'} className={styles.departure} />
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
              </div>
              <span className={`${styles.status} ${seatStatus(seat) === 'Ready' ? styles.ready : ''}`}>{seatStatus(seat)}</span>
          {isPlayer && seat.controller.kind !== 'human' ? (
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

      {isSpectator ? (
        <section className={styles.spectatorPanel} aria-label="Spectator controls">
          <div><strong>Spectating</strong><span>Choose a seat when you are ready to play.</span></div>
          {ownReservation ? <p role="status">Waiting to take over seat {ownReservation.seat + 1}.</p> : null}
          <Button variant="secondary" disabled={promotionDisabled || openSeats.length === 0} onClick={joinOpenSeat}>
            Join an open seat
          </Button>
          {availableBotSeats.map((seat) => (
            <Button key={seat.seat} variant="secondary" disabled={promotionDisabled} onClick={() => takeOverBot(seat)}>
              Take over seat {seat.seat + 1}
            </Button>
          ))}
        </section>
      ) : null}

      <section className={styles.readiness} aria-labelledby="readiness-title">
        <div>
          <h2 id="readiness-title">Ready to start?</h2>
          <strong className={styles.readinessStatus} role="status" aria-live="polite">{readinessMessage}</strong>
          {isPlayer ? <p className={styles.readinessHint}>
            {selfHuman?.ready ? 'You’re ready. ' : ''}The hand starts when all four seats are filled and every human is ready.
          </p> : null}
        </div>
        {isPlayer ? <Button
          disabled={commandsDisabled || !selfHuman || selfHuman.connection !== 'connected'}
          onClick={setReady}
        >
          {waitingMutationPending ? 'Updating…' : selfHuman?.ready ? 'Mark me not ready' : 'I’m ready'}
        </Button> : <span className={styles.spectatorReadiness}>You are watching this room.</span>}
      </section>
    </ScreenFrame>
  )
}
