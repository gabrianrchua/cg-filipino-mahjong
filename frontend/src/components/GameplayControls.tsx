import type {
  ActiveGameSnapshot,
  ChoiceId,
  LegalChoice,
  SeatView,
  SuitedTile,
} from '@cg-filipino-mahjong/shared'

import { compareHandTiles } from '../realtime/handArrangement.ts'
import { Button } from './Button.tsx'
import { MahjongTile } from './MahjongTile.tsx'
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

function choiceLabel(choice: ActionChoice): string {
  if (choice.kind === 'win') return choice.source === 'discard' ? 'Win on discard' : 'Win by self-draw'
  return CHOICE_LABELS[choice.kind]
}

function submitLabel(choice: ActionChoice): string {
  if (choice.kind === 'pass') return 'Submit pass'
  if (choice.kind === 'win') return 'Declare win'
  if (choice.kind === 'secret') return 'Declare secret'
  if (choice.kind === 'sagasa') return 'Declare sagása'
  return `Claim ${CHOICE_LABELS[choice.kind].toLocaleLowerCase()}`
}

export function GameplayControls({
  compact = false,
  acknowledgedResponse,
  actionError,
  attention,
  blocked,
  pending,
  preview,
  snapshot,
  onSubmit,
  selectedChoiceId,
  onSelectChoice,
  discardChoice,
  discardDisabled,
  interactionBlocked,
}: {
  readonly compact?: boolean
  readonly acknowledgedResponse: boolean
  readonly actionError: string | null
  readonly attention: boolean
  readonly blocked: boolean
  readonly pending: boolean
  readonly preview: boolean
  readonly snapshot: ActiveGameSnapshot
  readonly selectedChoiceId: ChoiceId | null
  readonly onSelectChoice: (choiceId: ChoiceId) => void
  readonly discardChoice: Extract<LegalChoice, { kind: 'discard' }> | undefined
  readonly discardDisabled: boolean
  readonly interactionBlocked: boolean
  readonly onSubmit: (choiceId: ChoiceId) => void
}) {
  const privateState = snapshot.privateState
  const localSeat = snapshot.seats[privateState?.seat ?? snapshot.self.seat ?? 0]!
  const choices = (privateState?.legalChoices.filter((choice): choice is ActionChoice => choice.kind !== 'discard') ?? [])
  const canDiscard = privateState?.legalChoices.some((choice) => choice.kind === 'discard') ?? false
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
  if (compact && !actionError && (pending || waitingMessage || (choices.length === 0 && !canDiscard))) return null

  return (
    <section className={`${styles.panel} ${compact ? styles.compact : ''} ${attention ? styles.attention : ''}`} aria-label={compact ? 'Your actions' : undefined} aria-labelledby={compact ? undefined : 'gameplay-actions-title'} aria-busy={pending} data-testid="gameplay-actions">
      {!compact ? <div className={styles.heading}>
        <h2 id="gameplay-actions-title">Your actions</h2>
        {responsePhase ? (
          <span className={styles.progress} role="status" aria-live="polite">
            {responsePhase.respondedSeats.length} of 3 responded
          </span>
        ) : null}
      </div> : null}

      {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
      {!compact && pending ? <p className={styles.waiting} role="status">Sending your choice…</p> : null}
      {!compact && !pending && waitingMessage ? <p className={styles.waiting} role="status">{waitingMessage}</p> : null}

      {!responded && !waitingMessage && (choices.length > 0 || canDiscard) ? (
        <>
          {choices.length > 0 ? <fieldset className={styles.choices} disabled={blocked || pending || interactionBlocked}>
            <legend>Choose an action</legend>
            {choices.map((choice) => {
              const tiles = [...choiceTiles(choice, snapshot, localSeat)].sort(compareHandTiles)
              const sameKindChoices = choices.filter((candidate) => candidate.kind === choice.kind)
              const optionNumber = sameKindChoices.findIndex((candidate) => candidate.choiceId === choice.choiceId) + 1
              return (
                <label className={styles.choice} key={choice.choiceId}>
                  <input
                    checked={selectedChoiceId === choice.choiceId}
                    name={`gameplay-choice-${snapshot.phase.phaseId}`}
                    onChange={() => onSelectChoice(choice.choiceId)}
                    type="radio"
                  />
                  <span className={styles.choiceCopy}>
                    <strong>{choiceLabel(choice)}{sameKindChoices.length > 1 ? ` · option ${optionNumber}` : ''}</strong>
                  </span>
                  {tiles.length > 0 ? (
                    <span className={styles.tileRow} aria-hidden="true">
                      {tiles.map((tile) => <MahjongTile compact key={tile.tileId} tile={tile} />)}
                    </span>
                  ) : null}
                </label>
              )
            })}
          </fieldset> : null}
          <div className={styles.submitRow}>
            <Button
              aria-label={discardChoice || (canDiscard && choices.length === 0) ? 'Discard selected tile' : undefined}
              disabled={blocked || pending || preview || interactionBlocked || (selectedChoice ? false : !discardChoice || discardDisabled)}
              onClick={() => {
                const choice = selectedChoice ?? discardChoice
                if (choice) onSubmit(choice.choiceId)
              }}
            >
              {selectedChoice ? submitLabel(selectedChoice) : discardChoice || (canDiscard && choices.length === 0) ? 'Discard' : 'Select an action'}
            </Button>
          </div>
        </>
      ) : null}

      {!compact && !pending && !waitingMessage && choices.length === 0 ? (
        <p className={styles.waiting} role="status">
          {canDiscard ? 'Select a tile in your hand, then discard it.' : 'No action is required from you right now.'}
        </p>
      ) : null}
    </section>
  )
}
