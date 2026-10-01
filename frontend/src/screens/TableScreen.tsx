import type { ActiveGameSnapshot, ChoiceId, Seat, SeatView, SuitedTile } from '@cg-filipino-mahjong/shared'
import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../components/Button.tsx'
import dialogStyles from '../components/RulesDialog.module.css'

import { PlaySettings } from '../components/PlaySettings.tsx'
import { GameplayControls } from '../components/GameplayControls.tsx'
import { BotIcon } from '../components/BotIcon.tsx'
import { HandRack } from '../components/HandRack.tsx'
import { MahjongTile, TileBack } from '../components/MahjongTile.tsx'
import { botDisplayName } from '../components/playerPresentation.ts'
import { MeldList } from '../components/MeldList.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { RoomDepartureControl } from '../components/RoomDepartureControl.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { sortedTileIds } from '../realtime/handArrangement.ts'
import { gameplayCommandForChoice, hasPendingRoomMembershipCommand } from '../realtime/state.ts'
import { useTileMotion } from './useTileMotion.ts'
import { DiscardPile } from './DiscardPile.tsx'
import styles from './TableScreen.module.css'

type TablePosition = 'local' | 'next' | 'across' | 'previous'

function seatName(seat: SeatView, isLocal: boolean): string {
  if (isLocal) return seat.controller.kind === 'human' ? `${seat.controller.displayName} (you)` : 'You'
  if (seat.controller.kind === 'human') return seat.controller.displayName
  return seat.controller.kind === 'bot' ? botDisplayName(seat.seat) : 'Open seat'
}

function seatStatus(snapshot: ActiveGameSnapshot, seat: Seat): string | null {
  if (snapshot.phase.kind === 'setup') return null
  if (snapshot.phase.kind === 'player-action') return snapshot.phase.actingSeat === seat ? 'Active' : null
  if (snapshot.phase.discarderSeat === seat) return 'Discarded'
  return snapshot.phase.respondedSeats.includes(seat) ? 'Responded' : 'Choosing'
}

function relativeSeat(localSeat: Seat, offset: number): Seat {
  return ((localSeat + offset) % 4) as Seat
}

function relativeSeatPositions(localSeat: Seat): Readonly<Record<TablePosition, Seat>> {
  return { local: localSeat, next: relativeSeat(localSeat, 1), across: relativeSeat(localSeat, 2), previous: relativeSeat(localSeat, 3) }
}

function waitingNames(snapshot: ActiveGameSnapshot, recipientSeat: Seat | null, acknowledgedResponse: boolean): string {
  if (snapshot.phase.kind !== 'discard-responses') return ''
  const { discarderSeat, respondedSeats } = snapshot.phase
  const outstanding = snapshot.seats.filter((seat) => (
    seat.seat !== discarderSeat
    && !respondedSeats.includes(seat.seat)
    && !(acknowledgedResponse && recipientSeat !== null && seat.seat === recipientSeat)
  )).map((seat) => seatName(seat, recipientSeat !== null && seat.seat === recipientSeat))
  if (outstanding.length === 0) return 'the table to resolve the responses'
  if (outstanding.length === 1) return outstanding[0]!
  return `${outstanding.slice(0, -1).join(', ')} and ${outstanding.at(-1)}`
}

function FlowerButton({ seat }: { readonly seat: SeatView }) {
  const label = `Show ${seat.flowers.length} ${seat.flowers.length === 1 ? 'flower' : 'flowers'} for ${seatName(seat, false)}`
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="secondary" className={styles.flowers} aria-label={label} title={label}>
          <svg className={styles.flowerIcon} viewBox="0 0 36 44" aria-hidden="true">
            <rect className={styles.flowerTile} x="7" y="1" width="27" height="36" rx="3" />
            <rect className={styles.flowerTile} x="2" y="5" width="27" height="36" rx="3" />
            <path className={styles.flowerStem} d="M15 33V20m0 9c-5 0-7-3-7-6m7 3c5 0 7-3 7-6" />
            <path className={styles.flowerPetals} d="M15 17c-9-7-9 4 0 3-3 9 8 7 3 0 9 2 7-9 0-3 3-9-8-9-3 0Z" />
            <circle cx="16.5" cy="18.5" r="2" fill="var(--color-tile-face)" />
          </svg>
          <span className={styles.flowerCount} aria-hidden="true">{seat.flowers.length}</span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.overlay} />
        <Dialog.Content className={`${dialogStyles.content} ${styles.flowerDialog}`} aria-describedby={undefined}>
          <Dialog.Title className={styles.flowerTitle}>{seatName(seat, false)}’s {seat.flowers.length} {seat.flowers.length === 1 ? 'flower' : 'flowers'}</Dialog.Title>
          <div className={`${styles.tileRow} ${styles.flowerTiles}`}>
            {seat.flowers.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
          </div>
          <Dialog.Close asChild><Button>Close flowers</Button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PublicTiles({ seat, handId }: { readonly seat: SeatView; readonly handId: string }) {
  if (!seat.melds.length && !seat.flowers.length) return null
  return (
    <div className={styles.publicTiles}>
      <MeldList
        key={handId}
        melds={seat.melds}
        label={`Public tiles for ${seatName(seat, false)}`}
        leadingItem={seat.flowers.length > 0 ? <><span className={styles.publicHeading}>Flowers</span><FlowerButton seat={seat} /></> : undefined}
      />
    </div>
  )
}

function SeatArea({ attention = false, isLocal, position, seat, snapshot }: {
  readonly attention?: boolean
  readonly isLocal: boolean
  readonly position: TablePosition
  readonly seat: SeatView
  readonly snapshot: ActiveGameSnapshot
}) {
  const name = seatName(seat, isLocal)
  const status = seatStatus(snapshot, seat.seat)
  const initial = Array.from(name)[0] ?? '?'
  if (isLocal && !seat.melds.length && !seat.flowers.length) return null
  return (
    <section className={`${styles.seatArea} ${styles[position]}`} data-seat={seat.seat} data-seat-position={position} aria-label={`${name}, ${seat.concealedCount} concealed tiles`}>
      {!isLocal ? <header data-motion-seat-anchor className={`${styles.seatCard} ${status === 'Active' ? styles.activeSeat : ''} ${attention ? styles.attentionSeat : ''}`}>
        <span className={styles.avatar} aria-hidden="true">
          {seat.controller.kind === 'bot' ? <BotIcon /> : initial}
        </span>
        <span className={styles.seatCopy}><strong>{name}</strong><small>{seat.concealedCount} concealed</small></span>
        <span className={styles.badges}>
          {seat.isDealer ? <span className={styles.dealer}>Dealer</span> : null}
          {status ? <span className={`${styles.status} ${status === 'Active' ? styles.active : ''}`}>{status}</span> : null}
        </span>
      </header> : <span className={styles.publicHeading}>Your public tiles</span>}
      <PublicTiles seat={seat} handId={snapshot.handId} />
    </section>
  )
}

function orderedLocalTiles(snapshot: ActiveGameSnapshot, tileOrder: readonly string[]): readonly SuitedTile[] {
  const concealed = snapshot.privateState?.concealedTiles ?? []
  const byId = new Map(concealed.map((tile) => [tile.tileId, tile]))
  const ordered = tileOrder.flatMap((tileId) => {
    const tile = byId.get(tileId)
    if (!tile) return []
    byId.delete(tileId)
    return [tile]
  })
  return [...ordered, ...byId.values()]
}

export function TableScreen({ roomCode, previewSnapshot, animatePreview = false }: {
  readonly roomCode: string
  readonly previewSnapshot?: ActiveGameSnapshot
  readonly animatePreview?: boolean
}) {
  const state = useRealtimeState()
  const actions = useRealtimeActions()
  const [arranging, setArranging] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [actionSelection, setActionSelection] = useState<{ phaseId: string; choiceId: ChoiceId } | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const handRef = useRef<HTMLElement>(null)
  const gameplaySubmissionRef = useRef<ChoiceId | null>(null)
  const [acknowledgedResponsePhaseId, setAcknowledgedResponsePhaseId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ readonly phaseId: string; readonly message: string } | null>(null)
  const [spectatorNotice, setSpectatorNotice] = useState('')
  const [previewHand, setPreviewHand] = useState(() => ({
    tileOrder: sortedTileIds(previewSnapshot?.privateState?.concealedTiles ?? []),
    selectedTileId: null as string | null,
    selectedPhaseId: null as string | null,
    autoSortHand: true,
  }))
  const liveSnapshot = state.roomSnapshot?.roomCode === roomCode && state.roomSnapshot.stage === 'playing' ? state.roomSnapshot : null
  const snapshot = previewSnapshot ?? liveSnapshot
  useTileMotion(
    snapshot,
    previewSnapshot ? !animatePreview : state.connectionStatus !== 'connected' || state.isResynchronizing || Boolean(snapshot?.pause.isPaused),
    tableRef,
    handRef,
  )

  if (!snapshot) {
    return (
      <ScreenFrame title="Restoring the table…" />
    )
  }

  const layoutSeat = snapshot.self.seat ?? 0
  const recipientSeat = snapshot.self.role === 'player' ? snapshot.self.seat : null
  const isSpectator = snapshot.self.role === 'spectator'
  const canPlay = snapshot.self.role === 'player' && snapshot.self.canControl && snapshot.privateState !== null
  const positions = relativeSeatPositions(layoutSeat)
  const seatAt = (position: TablePosition) => snapshot.seats[positions[position]]!
  const latestDiscard = snapshot.phase.kind === 'discard-responses' ? snapshot.phase.latestDiscard : null
  const currentPhaseLabel = snapshot.phase.kind === 'setup'
    ? 'Setting up'
    : snapshot.phase.kind === 'player-action'
      ? `${seatName(snapshot.seats[snapshot.phase.actingSeat]!, snapshot.phase.actingSeat === recipientSeat)} is active`
      : null
  const localTiles = orderedLocalTiles(snapshot, previewSnapshot
    ? previewHand.autoSortHand ? sortedTileIds(snapshot.privateState?.concealedTiles ?? []) : previewHand.tileOrder
    : state.localHand.tileOrder)
  const legalDiscardChoices = snapshot.privateState?.legalChoices.filter((choice) => choice.kind === 'discard') ?? []
  const legalDiscardTileIds = new Set(legalDiscardChoices.map((choice) => choice.tileId))
  const selectedTileId = previewSnapshot
    ? previewHand.selectedPhaseId === snapshot.phase.phaseId ? previewHand.selectedTileId : null
    : state.localHand.selectedTileId
  const selectedDiscardChoice = legalDiscardChoices.find((choice) => choice.tileId === selectedTileId)
  const discardAvailability = selectedDiscardChoice
    ? gameplayCommandForChoice(state, selectedDiscardChoice.choiceId)
    : null
  const gameplayPending = Object.values(state.pendingCommands).some((pending) => (
    pending.type === 'game.action' && pending.phaseId === snapshot.phase.phaseId
  ))
  const gameplayBlocked = previewSnapshot
    ? false
    : state.connectionStatus !== 'connected'
      || state.sessionStatus !== 'ready'
      || state.isResynchronizing
      || snapshot.pause.isPaused
      || !canPlay
  const acknowledgedResponse = acknowledgedResponsePhaseId === snapshot.phase.phaseId
  const responseReceived = snapshot.phase.kind === 'discard-responses' && (
    recipientSeat !== null && (snapshot.privateState?.hasResponded
    || snapshot.phase.respondedSeats.includes(recipientSeat)
    || acknowledgedResponse
    )
  )
  const availableChoices = snapshot.privateState?.legalChoices ?? []
  const hasOtherAction = availableChoices.some((choice) => choice.kind !== 'discard')
  const needsTurnAction = recipientSeat !== null && snapshot.phase.kind === 'player-action' && snapshot.phase.actingSeat === recipientSeat
  const needsResponse = snapshot.phase.kind === 'discard-responses'
    && recipientSeat !== null
    && snapshot.phase.discarderSeat !== recipientSeat
    && !responseReceived
  const needsAction = !gameplayBlocked && !gameplayPending && (needsTurnAction || needsResponse)
  const attention = isSpectator
    ? {
        title: 'Spectating',
        detail: snapshot.phase.kind === 'player-action'
          ? `Watching ${seatName(snapshot.seats[snapshot.phase.actingSeat]!, false)} play.`
          : snapshot.phase.kind === 'discard-responses'
            ? `Waiting for ${waitingNames(snapshot, null, false)}.`
            : 'The server is preparing the hand.',
        tone: 'waiting',
      }
    : gameplayBlocked
    ? { title: 'Table unavailable', detail: 'Play will resume when the table reconnects or the pause ends.', tone: 'blocked' }
    : gameplayPending
      ? { title: 'Sending your choice…', detail: 'Waiting for the server to acknowledge it.', tone: 'waiting' }
      : snapshot.phase.kind === 'setup'
        ? { title: 'Preparing the hand', detail: 'The server is dealing tiles and replacing flowers.', tone: 'waiting' }
        : needsTurnAction
          ? {
              title: 'Your turn',
              detail: hasOtherAction ? 'Choose an action below or select a tile to discard.' : 'Select a tile in your hand to discard.',
              tone: 'action',
            }
          : needsResponse
            ? { title: 'Your response needed', detail: 'Choose a claim or pass below.', tone: 'action' }
            : snapshot.phase.kind === 'player-action'
              ? {
                  title: 'Waiting for a player',
                  detail: `Waiting for ${seatName(snapshot.seats[snapshot.phase.actingSeat]!, false)} to play.`,
                  tone: 'waiting',
                }
              : {
                  title: responseReceived ? 'Response received' : 'Waiting for responses',
                  detail: `Waiting for ${waitingNames(snapshot, recipientSeat, acknowledgedResponse)}.`,
                  tone: 'waiting',
                }
  const reservedLeaveIssue = state.lastIssue?.kind === 'transport' && state.lastIssue.code === 'room-seat-reserved'
    ? state.lastIssue.message
    : null
  const ownReservation = snapshot.takeoverReservations.find((reservation) => reservation.isMine)
  const availableBotSeats = snapshot.seats.filter((seat) => (
    seat.controller.kind === 'bot'
    && !snapshot.takeoverReservations.some((reservation) => reservation.seat === seat.seat)
  ))
  const spectatorControlsDisabled = state.connectionStatus !== 'connected'
    || state.sessionStatus !== 'ready'
    || state.isResynchronizing
    || gameplayPending
    || hasPendingRoomMembershipCommand(state.pendingCommands)
    || Boolean(ownReservation)

  const submitGameplayChoice = (choiceId: ChoiceId) => {
    if (previewSnapshot || gameplaySubmissionRef.current) return
    gameplaySubmissionRef.current = choiceId
    setActionError(null)
    const submittedPhaseId = snapshot.phase.phaseId
    const wasResponse = snapshot.phase.kind === 'discard-responses'
    void actions.submitGameplayChoice(choiceId)
      .then((acknowledgement) => {
        if (acknowledgement.status === 'rejected') {
          setActionError({ phaseId: submittedPhaseId, message: acknowledgement.error.message })
          return
        }
        if (wasResponse) setAcknowledgedResponsePhaseId(submittedPhaseId)
      })
      .catch((caught: unknown) => {
        setActionError({
          phaseId: submittedPhaseId,
          message: caught instanceof Error ? caught.message : 'The action could not be completed.',
        })
      })
      .finally(() => {
        if (gameplaySubmissionRef.current === choiceId) gameplaySubmissionRef.current = null
      })
  }

  const toggleSort = () => {
    if (previewSnapshot) setPreviewHand((current) => ({
      ...current,
      autoSortHand: !current.autoSortHand,
      tileOrder: current.autoSortHand ? localTiles.map((tile) => tile.tileId) : [...sortedTileIds(localTiles)],
    }))
    else actions.toggleHandSort()
  }
  const selectTile = (tileId: string | null) => {
    setActionSelection(null)
    if (previewSnapshot) setPreviewHand((current) => ({ ...current, selectedTileId: tileId, selectedPhaseId: snapshot.phase.phaseId }))
    else actions.selectTile(tileId)
  }

  const requestTakeover = async (seat: Seat) => {
    if (!isSpectator || spectatorControlsDisabled || previewSnapshot) return
    setSpectatorNotice('')
    try {
      const acknowledgement = await actions.sendCommand({ type: 'room.takeover', roomCode: snapshot.roomCode, seat })
      if (acknowledgement.status === 'rejected') setSpectatorNotice(acknowledgement.error.message)
      else if (acknowledgement.result.kind === 'takeover-pending') setSpectatorNotice('Waiting for claims to finish.')
    } catch (caught) {
      setSpectatorNotice(caught instanceof Error ? caught.message : 'The takeover could not be requested.')
    }
  }

  return (
    <ScreenFrame playLayout tone="table" title="Mahjong table">
      {canPlay ? <PlaySettings
        autoSort={previewSnapshot ? previewHand.autoSortHand : state.autoSortHand}
        arranging={arranging}
        disabled={dragging}
        onSortToggle={toggleSort}
        onArrange={() => { selectTile(null); setArranging(!arranging) }}
      /> : null}
      <div className={styles.playScene}>
      {reservedLeaveIssue ? <p className={styles.switchNotice} role="alert">{reservedLeaveIssue}</p> : null}
      <div className={styles.boardScroll} tabIndex={0} role="region" aria-label="Public board">
      <div ref={tableRef} className={styles.table} aria-label="Mahjong table with four seats">
        <SeatArea position="across" seat={seatAt('across')} snapshot={snapshot} isLocal={false} />
        <SeatArea position="previous" seat={seatAt('previous')} snapshot={snapshot} isLocal={false} />
        <div className={styles.center}>
          <div className={styles.centerSummary}>
            <div className={styles.latestDiscard}>
              {latestDiscard ? (
                <><span>Latest discard</span><div data-motion-discard><MahjongTile tile={latestDiscard} latest /></div></>
              ) : (
                <strong>{currentPhaseLabel}</strong>
              )}
            </div>
            <span className={styles.wallStack} data-motion-wall role="img" aria-label={`${snapshot.wallRemainingCount} tiles remaining`}>
              <span className="tile-back"><TileBack compact /></span>
              <TileBack compact />
              <b className={styles.wallCount}>{snapshot.wallRemainingCount}</b>
            </span>
          </div>
          <DiscardPile key={snapshot.handId} tiles={snapshot.discards} pendingTileId={latestDiscard?.tileId ?? null} />
        </div>
        <SeatArea position="next" seat={seatAt('next')} snapshot={snapshot} isLocal={false} />
        <SeatArea position="local" seat={seatAt('local')} snapshot={snapshot} isLocal={recipientSeat !== null} attention={needsAction} />
      </div>
      </div>
      <div className={styles.dock}>
      <div className={`${styles.attention} ${styles[attention.tone]}`} role="status" aria-live="polite" data-testid="table-attention">
        {latestDiscard ? <span className={styles.responseTile} data-response-discard><MahjongTile compact tile={latestDiscard} /><span>Latest discard</span></span> : null}
        <strong>{attention.title}</strong>
        <span data-testid="attention-detail" className={styles.attentionDetail}>{attention.detail}</span>
        {snapshot.phase.kind === 'discard-responses' ? <span data-testid="response-progress">{snapshot.phase.respondedSeats.length} of 3 responded</span> : null}
      </div>
      <div className={styles.dockBody}>
      {isSpectator ? (
        <section className={styles.spectatorPanel} aria-label="Spectator controls">
          <div className={styles.spectatorPanelHeading}><strong>Spectating</strong><span>Watch the public board or take an available bot seat.</span></div>
          {ownReservation ? <p role="status">Takeover requested for seat {ownReservation.seat + 1}. Waiting for claims to finish.</p> : null}
          {spectatorNotice ? <p role="status">{spectatorNotice}</p> : null}
          {availableBotSeats.map((seat) => (
            <Button key={seat.seat} variant="secondary" disabled={spectatorControlsDisabled} onClick={() => void requestTakeover(seat.seat)}>
              Take over seat {seat.seat + 1}
            </Button>
          ))}
          <RoomDepartureControl roomId={snapshot.roomId} label="Stop spectating" />
        </section>
      ) : null}
      {canPlay ? <>
      <GameplayControls
        compact
        acknowledgedResponse={acknowledgedResponse}
        attention={needsAction}
        actionError={actionError?.phaseId === snapshot.phase.phaseId ? actionError.message : null}
        blocked={gameplayBlocked}
        pending={gameplayPending}
        preview={Boolean(previewSnapshot)}
        snapshot={snapshot}
        selectedChoiceId={actionSelection?.phaseId === snapshot.phase.phaseId ? actionSelection.choiceId : null}
        onSelectChoice={(choiceId) => {
          selectTile(null)
          setActionSelection({ phaseId: snapshot.phase.phaseId, choiceId })
        }}
        discardChoice={selectedDiscardChoice}
        discardDisabled={!discardAvailability?.ok}
        interactionBlocked={dragging || arranging}
        onSubmit={submitGameplayChoice}
      />
      <section ref={handRef} className={styles.handSection} aria-labelledby="hand-title">
        <div className={styles.handHeading} data-seat={recipientSeat!} data-motion-seat-anchor>
          <h2 id="hand-title">Your hand</h2>
          <span>{seatName(seatAt('local'), true)}{seatAt('local').isDealer ? ' · Dealer' : ''} · {seatAt('local').concealedCount} concealed</span>
        </div>
        <HandRack
          attention={needsAction && needsTurnAction}
          identity={`${snapshot.roomId}:${snapshot.handId}:${recipientSeat}`}
          tiles={localTiles}
          drawnTileId={snapshot.privateState?.drawnTileId ?? null}
          legalDiscardTileIds={legalDiscardTileIds}
          selectedTileId={selectedTileId}
          autoSortHand={previewSnapshot ? previewHand.autoSortHand : state.autoSortHand}
          arranging={arranging}
          onArrangeDone={() => setArranging(false)}
          onDraggingChange={setDragging}
          onSelect={selectTile}
          onOrderChange={(tileIds) => {
            if (previewSnapshot) setPreviewHand((current) => ({ ...current, tileOrder: [...tileIds], autoSortHand: false }))
            else actions.setTileOrder(tileIds)
          }}
          onSortToggle={toggleSort}
        />
      </section>
      </> : null}
      </div>
      </div>
      </div>
    </ScreenFrame>
  )
}
