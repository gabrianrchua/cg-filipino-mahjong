import type { ActiveGameSnapshot, ChoiceId, PlayerVisibleMeld, Seat, SeatView, SuitedTile } from '@cg-filipino-mahjong/shared'
import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../components/Button.tsx'
import dialogStyles from '../components/RulesDialog.module.css'

import { GameplayControls } from '../components/GameplayControls.tsx'
import { BotIcon } from '../components/BotIcon.tsx'
import { HandRack } from '../components/HandRack.tsx'
import { MahjongTile, TileBack } from '../components/MahjongTile.tsx'
import { botDisplayName } from '../components/playerPresentation.ts'
import { tileLabel } from '../components/tileLabels.ts'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { ShareRoomLink } from '../components/ShareRoomLink.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { sortedTileIds } from '../realtime/handArrangement.ts'
import { gameplayCommandForChoice } from '../realtime/state.ts'
import { useTileMotion } from './useTileMotion.ts'
import styles from './TableScreen.module.css'

type TablePosition = 'local' | 'next' | 'across' | 'previous'

const MELD_LABELS: Readonly<Record<PlayerVisibleMeld['kind'], string>> = {
  chow: 'Chow', pong: 'Pong', 'open-kang': 'Open káng', secret: 'Secret', sagasa: 'Sagása',
}

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

function waitingNames(snapshot: ActiveGameSnapshot, localSeat: Seat, acknowledgedResponse: boolean): string {
  if (snapshot.phase.kind !== 'discard-responses') return ''
  const { discarderSeat, respondedSeats } = snapshot.phase
  const outstanding = snapshot.seats.filter((seat) => (
    seat.seat !== discarderSeat
    && !respondedSeats.includes(seat.seat)
    && !(acknowledgedResponse && seat.seat === localSeat)
  )).map((seat) => seatName(seat, seat.seat === localSeat))
  if (outstanding.length === 0) return 'the table to resolve the responses'
  if (outstanding.length === 1) return outstanding[0]!
  return `${outstanding.slice(0, -1).join(', ')} and ${outstanding.at(-1)}`
}

function Meld({ meld }: { readonly meld: PlayerVisibleMeld }) {
  if (meld.kind === 'secret' && meld.visibility === 'masked') {
    return (
      <li className={styles.meld} data-motion-meld-id={meld.meldId} aria-label="Secret meld, four concealed tiles">
        <span className={styles.groupLabel}>Secret</span>
        <span className={styles.tileRow} aria-hidden="true">
          {Array.from({ length: meld.tileCount }, (_, index) => <TileBack compact key={`masked-${index}`} />)}
        </span>
      </li>
    )
  }
  const labels = meld.tiles.map(tileLabel).join(', ')
  return (
    <li className={styles.meld} data-motion-meld-id={meld.meldId} aria-label={`${MELD_LABELS[meld.kind]}: ${labels}`}>
      <span className={styles.groupLabel}>{MELD_LABELS[meld.kind]}</span>
      <span className={styles.tileRow} aria-hidden="true">
        {meld.tiles.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
      </span>
    </li>
  )
}

function PublicTiles({ seat, latestDiscardId }: { readonly seat: SeatView; readonly latestDiscardId: string | null }) {
  const deadDiscards = seat.discards.filter((tile) => tile.tileId !== latestDiscardId)
  if (!seat.melds.length && !seat.flowers.length && !deadDiscards.length) return null
  return (
    <div className={styles.publicTiles}>
      {seat.melds.length > 0 ? (
        <div className={styles.publicGroup}>
          <ul className={styles.melds}>{seat.melds.map((meld) => <Meld meld={meld} key={meld.meldId} />)}</ul>
        </div>
      ) : null}
      {seat.flowers.length > 0 ? (
        <Dialog.Root>
          <Dialog.Trigger asChild>
            <Button variant="secondary" className={styles.flowers} aria-label={`Show ${seat.flowers.length} flowers for ${seatName(seat, false)}`}>
              <span aria-hidden="true"><MahjongTile compact tile={seat.flowers[0]!} /></span>
              <span>Flowers · {seat.flowers.length}</span>
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className={dialogStyles.overlay} />
            <Dialog.Content className={`${dialogStyles.content} ${styles.flowerDialog}`} aria-describedby={undefined}>
              <Dialog.Title className={styles.flowerTitle}>{seatName(seat, false)}’s {seat.flowers.length} {seat.flowers.length === 1 ? 'flower' : 'flowers'}</Dialog.Title>
              <div className={`${styles.tileRow} ${styles.discards}`}>
                {seat.flowers.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
              </div>
              <Dialog.Close asChild><Button>Close flowers</Button></Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      {deadDiscards.length > 0 ? (
        <div className={styles.publicGroup}>
          <span className={styles.publicHeading}>Discards · {deadDiscards.length}</span>
          <div className={`${styles.tileRow} ${styles.discards}`} role="img" aria-label={`Dead discards: ${deadDiscards.map(tileLabel).join(', ')}`}>
            {deadDiscards.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SeatArea({ attention = false, isLocal, latestDiscardId, position, seat, snapshot }: {
  readonly attention?: boolean
  readonly isLocal: boolean
  readonly latestDiscardId: string | null
  readonly position: TablePosition
  readonly seat: SeatView
  readonly snapshot: ActiveGameSnapshot
}) {
  const name = seatName(seat, isLocal)
  const status = seatStatus(snapshot, seat.seat)
  const initial = Array.from(name)[0] ?? '?'
  if (isLocal && !seat.melds.length && !seat.flowers.length && !seat.discards.some((tile) => tile.tileId !== latestDiscardId)) return null
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
      <PublicTiles seat={seat} latestDiscardId={latestDiscardId} />
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
  const tableRef = useRef<HTMLDivElement>(null)
  const handRef = useRef<HTMLElement>(null)
  const gameplaySubmissionRef = useRef<ChoiceId | null>(null)
  const [acknowledgedResponsePhaseId, setAcknowledgedResponsePhaseId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<{ readonly phaseId: string; readonly message: string } | null>(null)
  const [previewHand, setPreviewHand] = useState(() => ({
    tileOrder: previewSnapshot?.privateState?.concealedTiles.map((tile) => tile.tileId) ?? [],
    selectedTileId: null as string | null,
    autoSortHand: false,
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

  const localSeat = snapshot.privateState?.seat ?? snapshot.self.seat
  if (localSeat === null) {
    return (
      <ScreenFrame title="Restoring your seat…" />
    )
  }

  const positions = relativeSeatPositions(localSeat)
  const seatAt = (position: TablePosition) => snapshot.seats[positions[position]]!
  const latestDiscard = snapshot.phase.kind === 'discard-responses' ? snapshot.phase.latestDiscard : null
  const currentPhaseLabel = snapshot.phase.kind === 'setup'
    ? 'Setting up'
    : snapshot.phase.kind === 'player-action'
      ? `${seatName(snapshot.seats[snapshot.phase.actingSeat]!, snapshot.phase.actingSeat === localSeat)} is active`
      : null
  const localTiles = orderedLocalTiles(snapshot, previewSnapshot ? previewHand.tileOrder : state.localHand.tileOrder)
  const legalDiscardChoices = snapshot.privateState?.legalChoices.filter((choice) => choice.kind === 'discard') ?? []
  const legalDiscardTileIds = new Set(legalDiscardChoices.map((choice) => choice.tileId))
  const selectedTileId = previewSnapshot ? previewHand.selectedTileId : state.localHand.selectedTileId
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
      || !snapshot.self.canControl
  const acknowledgedResponse = acknowledgedResponsePhaseId === snapshot.phase.phaseId
  const responseReceived = snapshot.phase.kind === 'discard-responses' && (
    snapshot.privateState?.hasResponded
    || snapshot.phase.respondedSeats.includes(localSeat)
    || acknowledgedResponse
  )
  const availableChoices = snapshot.privateState?.legalChoices ?? []
  const hasOtherAction = availableChoices.some((choice) => choice.kind !== 'discard')
  const needsTurnAction = snapshot.phase.kind === 'player-action' && snapshot.phase.actingSeat === localSeat
  const needsResponse = snapshot.phase.kind === 'discard-responses'
    && snapshot.phase.discarderSeat !== localSeat
    && !responseReceived
  const needsAction = !gameplayBlocked && !gameplayPending && (needsTurnAction || needsResponse)
  const attention = gameplayBlocked
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
                  detail: `Waiting for ${waitingNames(snapshot, localSeat, acknowledgedResponse)}.`,
                  tone: 'waiting',
                }
  const reservedLeaveIssue = state.lastIssue?.kind === 'transport' && state.lastIssue.code === 'room-seat-reserved'
    ? state.lastIssue.message
    : null

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

  return (
    <ScreenFrame playLayout tone="table" title="Mahjong table" actions={<div className={styles.roomIdentity}><strong aria-label={`Room code ${Array.from(roomCode).join(' ')}`}>{roomCode}</strong><ShareRoomLink compact roomCode={roomCode} /></div>}>
      <div className={styles.playScene}>
      {reservedLeaveIssue ? <p className={styles.switchNotice} role="alert">{reservedLeaveIssue}</p> : null}
      <div className={styles.boardScroll} tabIndex={0} role="region" aria-label="Public board">
      <div ref={tableRef} className={styles.table} aria-label="Mahjong table with four seats">
        <SeatArea position="across" seat={seatAt('across')} snapshot={snapshot} isLocal={false} latestDiscardId={latestDiscard?.tileId ?? null} />
        <SeatArea position="previous" seat={seatAt('previous')} snapshot={snapshot} isLocal={false} latestDiscardId={latestDiscard?.tileId ?? null} />
        <div className={styles.center}>
          {latestDiscard ? (
            <><span>Latest discard</span><div data-motion-discard><MahjongTile tile={latestDiscard} latest /></div></>
          ) : (
            <strong>{currentPhaseLabel}</strong>
          )}
          <span className={styles.wallStack} data-motion-wall role="img" aria-label={`${snapshot.wallRemainingCount} tiles remaining`}>
            <span className="tile-back"><TileBack compact /></span>
            <TileBack compact />
            <b className={styles.wallCount}>{snapshot.wallRemainingCount}</b>
          </span>
        </div>
        <SeatArea position="next" seat={seatAt('next')} snapshot={snapshot} isLocal={false} latestDiscardId={latestDiscard?.tileId ?? null} />
        <SeatArea position="local" seat={seatAt('local')} snapshot={snapshot} isLocal latestDiscardId={latestDiscard?.tileId ?? null} attention={needsAction} />
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
      <GameplayControls
        compact
        acknowledgedResponse={acknowledgedResponse}
        attention={needsAction && hasOtherAction}
        actionError={actionError?.phaseId === snapshot.phase.phaseId ? actionError.message : null}
        blocked={gameplayBlocked}
        pending={gameplayPending}
        preview={Boolean(previewSnapshot)}
        snapshot={snapshot}
        onSubmit={submitGameplayChoice}
      />
      <section ref={handRef} className={styles.handSection} aria-labelledby="hand-title">
        <div className={styles.handHeading} data-seat={localSeat} data-motion-seat-anchor>
          <h2 id="hand-title">Your hand</h2>
          <span>{seatName(seatAt('local'), true)}{seatAt('local').isDealer ? ' · Dealer' : ''} · {seatAt('local').concealedCount} concealed</span>
        </div>
        <HandRack
          attention={needsAction && needsTurnAction}
          identity={state.localHand.identity ?? `${snapshot.roomId}:${snapshot.handId}:${localSeat}`}
          tiles={localTiles}
          drawnTileId={snapshot.privateState?.drawnTileId ?? null}
          legalDiscardTileIds={legalDiscardTileIds}
          selectedTileId={selectedTileId}
          autoSortHand={previewSnapshot ? previewHand.autoSortHand : state.autoSortHand}
          discardDisabled={!discardAvailability?.ok}
          discardPending={gameplayPending}
          onSelect={(tileId) => {
            if (previewSnapshot) setPreviewHand((current) => ({ ...current, selectedTileId: tileId }))
            else actions.selectTile(tileId)
          }}
          onOrderChange={(tileIds) => {
            if (previewSnapshot) setPreviewHand((current) => ({ ...current, tileOrder: [...tileIds], autoSortHand: false }))
            else actions.setTileOrder(tileIds)
          }}
          onSortToggle={() => {
            if (previewSnapshot) setPreviewHand((current) => ({
              ...current,
              autoSortHand: !current.autoSortHand,
              tileOrder: current.autoSortHand ? current.tileOrder : [...sortedTileIds(localTiles)],
            }))
            else actions.toggleHandSort()
          }}
          onDiscard={() => {
            if (!selectedDiscardChoice || previewSnapshot) return
            submitGameplayChoice(selectedDiscardChoice.choiceId)
          }}
        />
      </section>
      </div>
      </div>
      </div>
    </ScreenFrame>
  )
}
