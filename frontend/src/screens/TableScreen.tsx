import type { ActiveGameSnapshot, PlayerVisibleMeld, Seat, SeatView, SuitedTile } from '@cg-filipino-mahjong/shared'
import { useRef, useState } from 'react'

import { HandRack } from '../components/HandRack.tsx'
import { MahjongTile, TileBack } from '../components/MahjongTile.tsx'
import { tileLabel } from '../components/tileLabels.ts'
import { PreviewSwitcher } from '../components/PreviewSwitcher.tsx'
import { RoomCodeBadge } from '../components/RoomCodeBadge.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { ShareRoomLink } from '../components/ShareRoomLink.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { gameplayCommandForChoice } from '../realtime/state.ts'
import styles from './TableScreen.module.css'

type TablePosition = 'local' | 'next' | 'across' | 'previous'

const MELD_LABELS: Readonly<Record<PlayerVisibleMeld['kind'], string>> = {
  chow: 'Chow', pong: 'Pong', 'open-kang': 'Open káng', secret: 'Secret', sagasa: 'Sagása',
}

function seatName(seat: SeatView, isLocal: boolean): string {
  if (isLocal) return seat.controller.kind === 'human' ? `${seat.controller.displayName} (you)` : 'You'
  if (seat.controller.kind === 'human') return seat.controller.displayName
  return seat.controller.kind === 'bot' ? 'Bot player' : 'Open seat'
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

function Meld({ meld }: { readonly meld: PlayerVisibleMeld }) {
  if (meld.kind === 'secret' && meld.visibility === 'masked') {
    return (
      <li className={styles.meld} aria-label="Secret meld, four concealed tiles">
        <span className={styles.groupLabel}>Secret</span>
        <span className={styles.tileRow} aria-hidden="true">
          {Array.from({ length: meld.tileCount }, (_, index) => <TileBack compact key={`masked-${index}`} />)}
        </span>
      </li>
    )
  }
  const labels = meld.tiles.map(tileLabel).join(', ')
  return (
    <li className={styles.meld} aria-label={`${MELD_LABELS[meld.kind]}: ${labels}`}>
      <span className={styles.groupLabel}>{MELD_LABELS[meld.kind]}</span>
      <span className={styles.tileRow} aria-hidden="true">
        {meld.tiles.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
      </span>
    </li>
  )
}

function PublicTiles({ seat, latestDiscardId }: { readonly seat: SeatView; readonly latestDiscardId: string | null }) {
  const deadDiscards = seat.discards.filter((tile) => tile.tileId !== latestDiscardId)
  return (
    <div className={styles.publicTiles}>
      {seat.melds.length > 0 ? (
        <div className={styles.publicGroup}>
          <span className={styles.publicHeading}>Melds</span>
          <ul className={styles.melds}>{seat.melds.map((meld) => <Meld meld={meld} key={meld.meldId} />)}</ul>
        </div>
      ) : null}
      {seat.flowers.length > 0 ? (
        <div className={styles.publicGroup} role="img" aria-label={`Flowers: ${seat.flowers.map(tileLabel).join(', ')}`}>
          <span className={styles.publicHeading}>Flowers</span>
          <div className={styles.tileRow} aria-hidden="true">
            {seat.flowers.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
          </div>
        </div>
      ) : null}
      <div className={styles.publicGroup}>
        <span className={styles.publicHeading}>Discards · {deadDiscards.length}</span>
        {deadDiscards.length > 0 ? (
          <div className={`${styles.tileRow} ${styles.discards}`} role="img" aria-label={`Dead discards: ${deadDiscards.map(tileLabel).join(', ')}`}>
            {deadDiscards.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
          </div>
        ) : <span className={styles.empty}>None yet</span>}
      </div>
    </div>
  )
}

function SeatArea({ isLocal, latestDiscardId, position, seat, snapshot }: {
  readonly isLocal: boolean
  readonly latestDiscardId: string | null
  readonly position: TablePosition
  readonly seat: SeatView
  readonly snapshot: ActiveGameSnapshot
}) {
  const name = seatName(seat, isLocal)
  const status = seatStatus(snapshot, seat.seat)
  const initial = Array.from(name)[0] ?? '?'
  const visibleBacks = Math.min(seat.concealedCount, 5)
  return (
    <section className={`${styles.seatArea} ${styles[position]}`} data-seat={seat.seat} data-seat-position={position} aria-label={`${name}, ${seat.concealedCount} concealed tiles`}>
      <header className={`${styles.seatCard} ${status === 'Active' ? styles.activeSeat : ''}`}>
        <span className={styles.avatar} aria-hidden="true">{initial}</span>
        <span className={styles.seatCopy}><strong>{name}</strong><small>{seat.concealedCount} concealed</small></span>
        <span className={styles.badges}>
          {seat.isDealer ? <span className={styles.dealer}>Dealer</span> : null}
          {status ? <span className={`${styles.status} ${status === 'Active' ? styles.active : ''}`}>{status}</span> : null}
        </span>
        {!isLocal ? (
          <span className={styles.concealed} aria-hidden="true">
            {Array.from({ length: visibleBacks }, (_, index) => <TileBack compact key={`seat-${seat.seat}-back-${index}`} />)}
            {seat.concealedCount > visibleBacks ? <small>+{seat.concealedCount - visibleBacks}</small> : null}
          </span>
        ) : null}
      </header>
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

export function TableScreen({ roomCode, previewSnapshot }: { readonly roomCode: string; readonly previewSnapshot?: ActiveGameSnapshot }) {
  const state = useRealtimeState()
  const actions = useRealtimeActions()
  const discardSubmissionRef = useRef<string | null>(null)
  const [previewHand, setPreviewHand] = useState(() => ({
    tileOrder: previewSnapshot?.privateState?.concealedTiles.map((tile) => tile.tileId) ?? [],
    selectedTileId: null as string | null,
  }))
  const liveSnapshot = state.roomSnapshot?.roomCode === roomCode && state.roomSnapshot.stage === 'playing' ? state.roomSnapshot : null
  const snapshot = previewSnapshot ?? liveSnapshot

  if (!snapshot) {
    return (
      <ScreenFrame eyebrow="Mahjong table" title="Restoring the table…" description="Waiting for the latest player-visible room snapshot.">
        <p role="status">Loading table…</p>
      </ScreenFrame>
    )
  }

  const localSeat = snapshot.privateState?.seat ?? snapshot.self.seat
  if (localSeat === null) {
    return (
      <ScreenFrame eyebrow="Mahjong table" title="Restoring your seat…" description="Your private seat view is not available yet.">
        <p role="status">Loading your seat…</p>
      </ScreenFrame>
    )
  }

  const positions = relativeSeatPositions(localSeat)
  const seatAt = (position: TablePosition) => snapshot.seats[positions[position]]!
  const latestDiscard = snapshot.phase.kind === 'discard-responses' ? snapshot.phase.latestDiscard : null
  const localTiles = orderedLocalTiles(snapshot, previewSnapshot ? previewHand.tileOrder : state.localHand.tileOrder)
  const legalDiscardChoices = snapshot.privateState?.legalChoices.filter((choice) => choice.kind === 'discard') ?? []
  const legalDiscardTileIds = new Set(legalDiscardChoices.map((choice) => choice.tileId))
  const selectedTileId = previewSnapshot ? previewHand.selectedTileId : state.localHand.selectedTileId
  const selectedDiscardChoice = legalDiscardChoices.find((choice) => choice.tileId === selectedTileId)
  const discardAvailability = selectedDiscardChoice
    ? gameplayCommandForChoice(state, selectedDiscardChoice.choiceId)
    : null
  const discardPending = Object.values(state.pendingCommands).some((pending) => (
    pending.type === 'game.action' && pending.phaseId === snapshot.phase.phaseId
  ))
  const phaseDescription = snapshot.phase.kind === 'setup'
    ? 'Dealing and replacing flowers'
    : snapshot.phase.kind === 'player-action'
      ? `${seatName(snapshot.seats[snapshot.phase.actingSeat]!, snapshot.phase.actingSeat === localSeat)} is active`
      : `${snapshot.phase.respondedSeats.length} of 3 opponents responded`

  return (
    <ScreenFrame tone="table" eyebrow="Mahjong table" title="Everything has its place."
      description="Your hand stays readable while the public table follows the authoritative player-visible state."
      actions={<PreviewSwitcher active="table" />}>
      <div className={styles.meta}>
        <div className={styles.roomIdentity}><RoomCodeBadge code={roomCode} /><ShareRoomLink roomCode={roomCode} /></div>
        <span><strong>{snapshot.wallRemainingCount}</strong> tiles in wall</span>
        <span role="status">{phaseDescription}</span>
      </div>
      <div className={styles.table} aria-label="Mahjong table with four seats">
        <SeatArea position="across" seat={seatAt('across')} snapshot={snapshot} isLocal={false} latestDiscardId={latestDiscard?.tileId ?? null} />
        <SeatArea position="previous" seat={seatAt('previous')} snapshot={snapshot} isLocal={false} latestDiscardId={latestDiscard?.tileId ?? null} />
        <div className={styles.center}>
          {latestDiscard ? (
            <><span>Latest discard</span><MahjongTile tile={latestDiscard} latest /><strong>Waiting for responses</strong></>
          ) : (
            <><span>Current phase</span><strong>{snapshot.phase.kind === 'setup' ? 'Setting up' : 'Player action'}</strong></>
          )}
        </div>
        <SeatArea position="next" seat={seatAt('next')} snapshot={snapshot} isLocal={false} latestDiscardId={latestDiscard?.tileId ?? null} />
        <SeatArea position="local" seat={seatAt('local')} snapshot={snapshot} isLocal latestDiscardId={latestDiscard?.tileId ?? null} />
      </div>
      <section className={styles.handSection} aria-labelledby="hand-title">
        <div className={styles.handHeading}>
          <div><h2 id="hand-title">Your hand</h2><p>{localTiles.length} tiles · horizontal scroll on compact screens</p></div>
          <span>Arrange freely; gameplay choices remain server-authorized.</span>
        </div>
        <HandRack
          identity={state.localHand.identity ?? `${snapshot.roomId}:${snapshot.handId}:${localSeat}`}
          tiles={localTiles}
          drawnTileId={snapshot.privateState?.drawnTileId ?? null}
          legalDiscardTileIds={legalDiscardTileIds}
          selectedTileId={selectedTileId}
          discardDisabled={!discardAvailability?.ok}
          discardPending={discardPending}
          onSelect={(tileId) => {
            if (previewSnapshot) setPreviewHand((current) => ({ ...current, selectedTileId: tileId }))
            else actions.selectTile(tileId)
          }}
          onOrderChange={(tileIds) => {
            if (previewSnapshot) setPreviewHand((current) => ({ ...current, tileOrder: [...tileIds] }))
            else actions.setTileOrder(tileIds)
          }}
          onDiscard={() => {
            if (!selectedDiscardChoice || previewSnapshot) return
            if (discardSubmissionRef.current === selectedDiscardChoice.choiceId) return
            discardSubmissionRef.current = selectedDiscardChoice.choiceId
            void actions.submitGameplayChoice(selectedDiscardChoice.choiceId)
              .catch(() => undefined)
              .finally(() => {
                if (discardSubmissionRef.current === selectedDiscardChoice.choiceId) discardSubmissionRef.current = null
              })
          }}
        />
      </section>
      <div className={styles.actionSpace} data-testid="future-action-space" aria-hidden="true" />
    </ScreenFrame>
  )
}
