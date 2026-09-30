import * as Dialog from '@radix-ui/react-dialog'
import type { Proposal, RoomSnapshot, Seat, SeatView } from '@cg-filipino-mahjong/shared'
import { useEffect, useRef, useState } from 'react'

import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { Button } from './Button.tsx'
import { RoomDepartureControl } from './RoomDepartureControl.tsx'
import styles from './RoomInterruptionDialog.module.css'

const DECISION_COMMANDS = new Set(['proposal.create', 'proposal.vote'])

function seatName(snapshot: RoomSnapshot, seat: Seat): string {
  const controller = snapshot.seats[seat]?.controller
  return controller?.kind === 'human' ? controller.displayName : `Seat ${seat + 1}`
}

function connectedHumanSeats(snapshot: RoomSnapshot): string {
  return snapshot.seats
    .filter((seat) => seat.controller.kind === 'human' && seat.controller.connection === 'connected')
    .map((seat) => seat.seat)
    .join(',')
}

function proposalOutcome(previous: Proposal, previousConnected: string, snapshot: RoomSnapshot): string {
  if (previous.kind === 'replace-with-bot' && previous.targetSeat !== null) {
    if (snapshot.seats[previous.targetSeat]?.controller.kind === 'bot') {
      return `${seatName(snapshot, previous.targetSeat)} is now bot-controlled.`
    }
  }
  if (previousConnected !== connectedHumanSeats(snapshot)) {
    return 'The proposal was canceled because the connected players changed. A new proposal can be started if needed.'
  }
  return snapshot.pause.isPaused
    ? 'The proposal was rejected or is no longer active.'
    : 'The table is ready to continue.'
}

function disconnectedHumans(snapshot: RoomSnapshot): SeatView[] {
  const disconnected = new Set(snapshot.pause.disconnectedSeats)
  return snapshot.seats.filter((seat) => (
    disconnected.has(seat.seat)
    && seat.controller.kind === 'human'
  ))
}

export function RoomInterruptionDialog({ snapshot }: { readonly snapshot: RoomSnapshot }) {
  const state = useRealtimeState()
  const { resynchronize, sendCommand } = useRealtimeActions()
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const commandInFlight = useRef(false)
  const previous = useRef({
    proposal: snapshot.proposal,
    connectedSeats: connectedHumanSeats(snapshot),
    roomId: snapshot.roomId,
  })

  const localInterruption = state.connectionStatus !== 'connected'
    || state.sessionStatus !== 'ready'
    || state.isResynchronizing
  const open = localInterruption || snapshot.pause.isPaused
  const missing = disconnectedHumans(snapshot)
  const selfVote = snapshot.proposal?.votes.find((vote) => vote.seat === snapshot.self.seat)
  const approvedCount = snapshot.proposal?.votes.filter((vote) => vote.status === 'approved').length ?? 0
  const commandPending = Object.values(state.pendingCommands).some((pending) => (
    pending.roomId === snapshot.roomId && DECISION_COMMANDS.has(pending.type)
  ))
  const controlsDisabled = localInterruption || commandPending || submitting
  const canParticipate = snapshot.self.role === 'player' && snapshot.self.canControl

  useEffect(() => {
    const prior = previous.current
    if (prior.roomId === snapshot.roomId && prior.proposal && !snapshot.proposal) {
      setAnnouncement(proposalOutcome(prior.proposal, prior.connectedSeats, snapshot))
    } else if (snapshot.proposal?.proposalId !== prior.proposal?.proposalId) {
      setAnnouncement('')
    }
    previous.current = {
      proposal: snapshot.proposal,
      connectedSeats: connectedHumanSeats(snapshot),
      roomId: snapshot.roomId,
    }
    setError('')
  }, [snapshot, snapshot.proposal?.proposalId, snapshot.roomId, snapshot.roomRevision])

  if (snapshot.self.role === 'spectator') {
    if (!localInterruption && !snapshot.pause.isPaused && !snapshot.proposal) return null
    const title = localInterruption
      ? state.connectionStatus === 'disconnected' ? 'Connection interrupted' : 'Restoring connection'
      : 'The table is paused'
    const detail = localInterruption
      ? 'The public board remains available while the connection is restored.'
      : snapshot.proposal
        ? `${snapshot.proposal.kind === 'abort-hand' ? 'Abort the hand' : `Replace seat ${snapshot.proposal.targetSeat! + 1}`} proposed. ${approvedCount} of ${snapshot.proposal.votes.length} approvals.`
        : 'Play resumes when each disconnected player returns or is replaced.'
    return (
      <aside className={styles.spectatorNotice} role="status" aria-live="polite">
        <strong>{title}</strong><span>{detail}</span>
        {state.connectionStatus === 'disconnected' ? <Button variant="secondary" onClick={resynchronize}>Reconnect</Button> : null}
      </aside>
    )
  }

  const runCommand = async (command: Parameters<typeof sendCommand>[0]) => {
    if (commandInFlight.current || controlsDisabled) return
    commandInFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      const acknowledgement = await sendCommand(command)
      if (acknowledgement.status === 'rejected') setError(acknowledgement.error.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The table decision could not be submitted.')
    } finally {
      commandInFlight.current = false
      setSubmitting(false)
    }
  }

  const proposeReplacement = (seat: Seat) => {
    void runCommand({
      type: 'proposal.create',
      roomId: snapshot.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: seat },
    })
  }

  const proposeAbort = () => {
    void runCommand({
      type: 'proposal.create',
      roomId: snapshot.roomId,
      proposal: { kind: 'abort-hand' },
    })
  }

  const vote = (choice: 'approve' | 'reject') => {
    if (!snapshot.proposal) return
    void runCommand({
      type: 'proposal.vote',
      roomId: snapshot.roomId,
      proposalId: snapshot.proposal.proposalId,
      vote: choice,
    })
  }

  const connectionTitle = state.connectionStatus === 'superseded'
    ? 'This guest session moved to another tab.'
    : state.connectionStatus === 'disconnected'
      ? 'Your connection was interrupted.'
      : 'Restoring your connection…'

  return (
    <Dialog.Root open={open}>
      {open ? (
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={styles.content}
            aria-describedby={localInterruption ? undefined : 'room-interruption-description'}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            {localInterruption ? (
              <>
                <Dialog.Title className={styles.title}>{connectionTitle}</Dialog.Title>
                {state.connectionStatus === 'disconnected' ? (
                  <Button className={styles.fullButton} onClick={resynchronize}>Reconnect</Button>
                ) : null}
              </>
            ) : (
              <>
                <Dialog.Title className={styles.title}>
                  {missing.length === 1 ? 'A player is disconnected.' : `${missing.length} players are disconnected.`}
                </Dialog.Title>
                <Dialog.Description id="room-interruption-description" className={styles.description}>
                  Play resumes when each missing player returns, is replaced, or the hand is ended.
                </Dialog.Description>

                <ul className={styles.missingList} aria-label="Disconnected players">
                  {missing.map((seat) => (
                    <li key={seat.seat}>
                      <span><strong>{seatName(snapshot, seat.seat)}</strong><small>Seat {seat.seat + 1}</small></span>
                      <span className={styles.disconnected}>Disconnected</span>
                    </li>
                  ))}
                </ul>

                {snapshot.proposal ? (
                  <section className={styles.proposal} aria-labelledby="proposal-title">
                    <h2 id="proposal-title">
                      {snapshot.proposal.kind === 'abort-hand'
                        ? 'Abort the current hand'
                        : `Replace ${seatName(snapshot, snapshot.proposal.targetSeat!)} with a bot`}
                    </h2>
                    <p>Proposed by {seatName(snapshot, snapshot.proposal.proposedBy)}.</p>
                    <strong role="status">{approvedCount} of {snapshot.proposal.votes.length} approvals</strong>
                    <ul className={styles.voteList}>
                      {snapshot.proposal.votes.map((entry) => (
                        <li key={entry.seat}>
                          <span>{seatName(snapshot, entry.seat)}</span>
                          <span>{entry.status === 'approved' ? 'Approved' : 'Waiting'}</span>
                        </li>
                      ))}
                    </ul>
                    {canParticipate ? <div className={styles.actions}>
                      <Button disabled={controlsDisabled || selfVote?.status === 'approved'} onClick={() => vote('approve')}>
                        {commandPending ? 'Submitting…' : selfVote?.status === 'approved' ? 'Approved' : 'Approve'}
                      </Button>
                      <Button variant="secondary" disabled={controlsDisabled} onClick={() => vote('reject')}>Reject proposal</Button>
                    </div> : null}
                  </section>
                ) : (
                  <section className={styles.proposal} aria-labelledby="proposal-title">
                    <h2 id="proposal-title">{canParticipate ? 'Propose what happens next' : 'Waiting for a player decision'}</h2>
                    {canParticipate ? (
                    <div className={styles.actions}>
                      {missing.map((seat) => (
                        <Button variant="secondary" disabled={controlsDisabled} key={seat.seat} onClick={() => proposeReplacement(seat.seat)}>
                          Replace {seatName(snapshot, seat.seat)} with a bot
                        </Button>
                      ))}
                      {snapshot.stage === 'playing' ? (
                        <Button variant="secondary" disabled={controlsDisabled} onClick={proposeAbort}>Propose aborting the hand</Button>
                      ) : null}
                    </div>
                    ) : null}
                  </section>
                )}

                {snapshot.stage !== 'playing' ? (
                  <RoomDepartureControl roomId={snapshot.roomId} label="Leave room" className={styles.departure} />
                ) : null}
                {error ? <p className={styles.error} role="alert">{error}</p> : null}
                {announcement ? <p className={styles.announcement} role="status" aria-live="polite">{announcement}</p> : null}
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}
