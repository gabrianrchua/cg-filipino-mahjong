import type {
  ActiveGameSnapshot,
  ChoiceId,
  LegalChoice,
  SeatView,
  SuitedTile,
} from '@cg-filipino-mahjong/shared'
import { useState } from 'react'

import { compareHandTiles } from '../realtime/handArrangement.ts'
import { Button } from './Button.tsx'
import { MahjongTile } from './MahjongTile.tsx'
import { tileLabel } from './tileLabels.ts'
import styles from './GameplayControls.module.css'

type ActionChoice = Exclude<LegalChoice, { kind: 'discard' }>

const CHOICE_LABELS: Readonly<Record<ActionChoice['kind'], string>> = {
  pass: 'Pass',
  win: 'Win',
  chow: 'Chow',
  pong: 'Pong',
  'open-kang': 'Open káng',
  secret: 'Secret',
  sagasa: 'Sagása',
}

function choiceTiles(choice: ActionChoice, snapshot: ActiveGameSnapshot, localSeat: SeatView): readonly SuitedTile[] {
  const concealed = snapshot.privateState?.concealedTiles ?? []
  const concealedById = new Map(concealed.map((tile) => [tile.tileId, tile]))
  if (choice.kind === 'chow' || choice.kind === 'pong' || choice.kind === 'open-kang') {
    const selected = choice.concealedTileIds.flatMap((tileId) => {
      const tile = concealedById.get(tileId)
      return tile ? [tile] : []
    })
    return snapshot.phase.kind === 'discard-responses'
      ? [...selected, snapshot.phase.latestDiscard]
      : selected
  }
  if (choice.kind === 'secret') {
    return choice.concealedTileIds.flatMap((tileId) => {
      const tile = concealedById.get(tileId)
      return tile ? [tile] : []
    })
  }
  if (choice.kind === 'sagasa') {
    const meld = localSeat.melds.find((candidate) => candidate.meldId === choice.meldId)
    const fourth = concealedById.get(choice.tileId)
    return [
      ...(meld && 'tiles' in meld ? meld.tiles : []),
      ...(fourth ? [fourth] : []),
    ]
  }
  if (choice.kind === 'win') {
    if (choice.source === 'discard' && snapshot.phase.kind === 'discard-responses') {
      return [snapshot.phase.latestDiscard]
    }
    const drawn = concealed.find((tile) => tile.tileId === snapshot.privateState?.drawnTileId)
    return drawn ? [drawn] : []
  }
  return []
}

function choiceDescription(choice: ActionChoice, tiles: readonly SuitedTile[]): string {
  if (choice.kind === 'pass') return 'Decline this discard.'
  if (choice.kind === 'win') {
    return choice.source === 'discard'
      ? 'Declare a win using the latest discard.'
      : 'Declare a win using your current draw.'
  }
  const labels = tiles.map(tileLabel).join(', ')
  if (choice.kind === 'secret') return `Conceal four matching tiles: ${labels}.`
  if (choice.kind === 'sagasa') return `Upgrade this open pong with the tile you just drew: ${labels}.`
  return `Claim the latest discard with: ${labels}.`
}

function submitLabel(choice: ActionChoice): string {
  if (choice.kind === 'pass') return 'Submit pass'
  if (choice.kind === 'win') return 'Declare win'
  if (choice.kind === 'secret') return 'Declare secret'
  if (choice.kind === 'sagasa') return 'Declare sagása'
  return `Claim ${CHOICE_LABELS[choice.kind].toLocaleLowerCase()}`
}

export function GameplayControls({
  acknowledgedResponse,
  actionError,
  blocked,
  pending,
  preview,
  snapshot,
  onSubmit,
}: {
  readonly acknowledgedResponse: boolean
  readonly actionError: string | null
  readonly blocked: boolean
  readonly pending: boolean
  readonly preview: boolean
  readonly snapshot: ActiveGameSnapshot
  readonly onSubmit: (choiceId: ChoiceId) => void
}) {
  const [selectedChoiceId, setSelectedChoiceId] = useState<ChoiceId | null>(null)
  const privateState = snapshot.privateState
  const localSeat = snapshot.seats[privateState?.seat ?? snapshot.self.seat ?? 0]!
  const choices = (privateState?.legalChoices.filter((choice): choice is ActionChoice => choice.kind !== 'discard') ?? [])
  const selectedChoice = choices.find((choice) => choice.choiceId === selectedChoiceId) ?? null
  const responsePhase = snapshot.phase.kind === 'discard-responses' ? snapshot.phase : null
  const responded = responsePhase !== null && (
    privateState?.hasResponded
    || responsePhase.respondedSeats.includes(localSeat.seat)
    || acknowledgedResponse
  )

  let waitingMessage: string | null = null
  if (snapshot.phase.kind === 'setup') waitingMessage = 'The server is dealing tiles and replacing flowers automatically.'
  if (snapshot.phase.kind === 'player-action' && snapshot.phase.actingSeat !== localSeat.seat) {
    waitingMessage = 'Waiting for the active player.'
  }
  if (responsePhase && responsePhase.discarderSeat === localSeat.seat) {
    waitingMessage = 'Your discard is waiting for all three opponents.'
  }
  if (blocked && !waitingMessage) {
    waitingMessage = 'Gameplay actions are temporarily unavailable while the table is paused or reconnecting.'
  }
  if (responded) waitingMessage = 'Response received. Waiting for the other opponents.'

  return (
    <section className={styles.panel} aria-labelledby="gameplay-actions-title" aria-busy={pending} data-testid="gameplay-actions">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your actions</p>
          <h2 id="gameplay-actions-title">Choose explicitly.</h2>
        </div>
        {responsePhase ? (
          <span className={styles.progress} role="status" aria-live="polite">
            {responsePhase.respondedSeats.length} of 3 responded
          </span>
        ) : null}
      </div>

      {responsePhase ? (
        <p className={styles.priority}>Wins resolve first, then pong or open káng, then chow. Resolution waits for every opponent.</p>
      ) : (
        <p className={styles.priority}>Gifts and flower replacements happen automatically after an accepted action.</p>
      )}

      {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
      {pending ? <p className={styles.waiting} role="status">Sending your choice…</p> : null}
      {!pending && waitingMessage ? <p className={styles.waiting} role="status">{waitingMessage}</p> : null}

      {!responded && !waitingMessage && choices.length > 0 ? (
        <>
          <fieldset className={styles.choices} disabled={blocked || pending}>
            <legend>Select an action to inspect before submitting</legend>
            {choices.map((choice) => {
              const tiles = [...choiceTiles(choice, snapshot, localSeat)].sort(compareHandTiles)
              const sameKindChoices = choices.filter((candidate) => candidate.kind === choice.kind)
              const optionNumber = sameKindChoices.findIndex((candidate) => candidate.choiceId === choice.choiceId) + 1
              return (
                <label className={styles.choice} key={choice.choiceId}>
                  <input
                    checked={selectedChoiceId === choice.choiceId}
                    name={`gameplay-choice-${snapshot.phase.phaseId}`}
                    onChange={() => setSelectedChoiceId(choice.choiceId)}
                    type="radio"
                  />
                  <span className={styles.choiceCopy}>
                    <strong>{CHOICE_LABELS[choice.kind]}{sameKindChoices.length > 1 ? ` · option ${optionNumber}` : ''}</strong>
                    <small>{choiceDescription(choice, tiles)}</small>
                  </span>
                  {tiles.length > 0 ? (
                    <span className={styles.tileRow} aria-hidden="true">
                      {tiles.map((tile) => <MahjongTile compact key={tile.tileId} tile={tile} />)}
                    </span>
                  ) : null}
                </label>
              )
            })}
          </fieldset>
          <div className={styles.submitRow}>
            <span>{selectedChoice ? 'Review the highlighted tiles, then confirm.' : 'Nothing is submitted until you confirm.'}</span>
            <Button
              disabled={!selectedChoice || blocked || pending || preview}
              onClick={() => selectedChoice && onSubmit(selectedChoice.choiceId)}
            >
              {selectedChoice ? submitLabel(selectedChoice) : 'Select an action'}
            </Button>
          </div>
        </>
      ) : null}

      {!waitingMessage && choices.length === 0 ? (
        <p className={styles.waiting} role="status">No action is required from you right now.</p>
      ) : null}
    </section>
  )
}
