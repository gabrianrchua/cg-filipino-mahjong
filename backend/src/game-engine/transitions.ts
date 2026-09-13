import type { Seat } from '@cg-filipino-mahjong/shared'

import { acquireTile, completeInitialSetup } from './draws.js'
import { validateEngineState } from './invariants.js'
import type {
  EngineAction,
  EngineError,
  EngineState,
  EngineTile,
  EngineTransitionResult,
  FourSeatStates,
  SeatState,
} from './model.js'
import {
  chooseDealer,
  createCanonicalTileSet,
  nextSeat,
  shuffleTiles,
  systemRandomSource,
  type RandomSource,
} from './tiles.js'

const seats = (): FourSeatStates => [0, 1, 2, 3].map((seat) => ({
  seat: seat as Seat,
  concealedTiles: Object.freeze([]),
  melds: Object.freeze([]),
  flowers: Object.freeze([]),
})) as unknown as FourSeatStates

const rejected = (error: EngineError): EngineTransitionResult => ({ accepted: false, error })

function accepted(state: EngineState): EngineTransitionResult {
  const issues = validateEngineState(state)
  return issues.length === 0
    ? { accepted: true, state }
    : rejected({
        code: 'invalid-state',
        message: 'Engine action produced an invalid state.',
        issues,
      })
}

function replaceSeat(state: EngineState, replacement: SeatState): EngineState {
  const seats = state.seats.map((seat) => seat.seat === replacement.seat ? replacement : seat) as unknown as FourSeatStates
  return { ...state, seats }
}

export interface InitializeHandOptions {
  readonly dealerSeat?: Seat
  readonly wall?: readonly EngineTile[]
  readonly randomSource?: RandomSource
}

export function initializeHand(options: InitializeHandOptions = {}): EngineTransitionResult {
  const randomSource = options.randomSource ?? systemRandomSource
  let dealerSeat: Seat
  let wall: readonly EngineTile[]

  try {
    dealerSeat = options.dealerSeat ?? chooseDealer(randomSource)
    if (![0, 1, 2, 3].includes(dealerSeat)) {
      return rejected({ code: 'invalid-dealer', message: 'Dealer must be one of seats 0 through 3.' })
    }
    wall = options.wall ? Object.freeze([...options.wall]) : shuffleTiles(createCanonicalTileSet(), randomSource)
  } catch (error) {
    return rejected({
      code: 'invalid-random-value',
      message: error instanceof Error ? error.message : 'Random source produced an invalid value.',
    })
  }

  const tileUniverse = Object.freeze([...wall])
  const initialState: EngineState = {
    tileUniverse,
    dealerSeat,
    seats: seats(),
    wall: { remainingTiles: wall },
    discards: Object.freeze([]),
    currentDraw: null,
    phase: { kind: 'setup' },
  }
  const issues = validateEngineState(initialState)
  if (issues.length > 0) {
    return rejected({ code: 'invalid-wall', message: 'Initial wall fixture contains invalid physical tiles.', issues })
  }

  const state = completeInitialSetup(initialState)
  const finalIssues = validateEngineState(state)
  if (finalIssues.length > 0) {
    return rejected({ code: 'invalid-state', message: 'Automatic hand setup produced an invalid engine state.', issues: finalIssues })
  }
  return { accepted: true, state }
}

export type ActionCompatibilityResult =
  | { readonly accepted: true; readonly action: EngineAction }
  | { readonly accepted: false; readonly error: EngineError }

export function validateActionForPhase(state: EngineState, action: EngineAction): ActionCompatibilityResult {
  const stateIssues = validateEngineState(state)
  if (stateIssues.length > 0) {
    return { accepted: false, error: { code: 'invalid-state', message: 'Cannot transition an invalid engine state.', issues: stateIssues } }
  }

  if (state.phase.kind === 'setup' || state.phase.kind === 'ended') {
    return { accepted: false, error: { code: 'invalid-action-for-phase', message: `Actions are not accepted during the ${state.phase.kind} phase.` } }
  }
  if (state.phase.kind === 'player-action') {
    if (action.kind === 'respond-to-discard') {
      return { accepted: false, error: { code: 'invalid-action-for-phase', message: 'Discard responses require a discard-response phase.' } }
    }
    if (action.seat !== state.phase.actingSeat) {
      return { accepted: false, error: { code: 'out-of-turn', message: 'Only the acting seat may take a player action.' } }
    }
    return { accepted: true, action }
  }
  if (action.kind !== 'respond-to-discard') {
    return { accepted: false, error: { code: 'invalid-action-for-phase', message: 'Only discard responses are accepted in this phase.' } }
  }
  if (action.seat === state.phase.discarderSeat) {
    return { accepted: false, error: { code: 'out-of-turn', message: 'The discarder cannot respond to their own discard.' } }
  }
  if (state.phase.responses.some((response) => response.seat === action.seat)) {
    return { accepted: false, error: { code: 'out-of-turn', message: 'This seat has already submitted its final response.' } }
  }
  return { accepted: true, action }
}

/**
 * Returns complete engine actions that a seat may submit in the current state.
 * Later rule tickets extend this list with wins, melds, and discard claims.
 */
export function getLegalActions(state: EngineState, seat: Seat): readonly EngineAction[] {
  if (validateEngineState(state).length > 0) return Object.freeze([])

  if (state.phase.kind === 'player-action') {
    if (state.phase.actingSeat !== seat) return Object.freeze([])
    return Object.freeze(state.seats[seat]!.concealedTiles.map((tile) => ({
      kind: 'discard' as const,
      seat,
      tileId: tile.tileId,
    })))
  }

  if (
    state.phase.kind === 'discard-responses'
    && state.phase.discarderSeat !== seat
    && !state.phase.responses.some((response) => response.seat === seat)
  ) {
    return Object.freeze([{ kind: 'respond-to-discard', seat, choice: { kind: 'pass' } }])
  }

  return Object.freeze([])
}

function applyDiscard(
  state: EngineState,
  action: Extract<EngineAction, { kind: 'discard' }>,
): EngineTransitionResult {
  const owner = state.seats[action.seat]!
  const tileIndex = owner.concealedTiles.findIndex((tile) => tile.tileId === action.tileId)
  if (tileIndex < 0) {
    return rejected({
      code: 'invalid-tile-selection',
      message: 'A discard must select a suited tile in the acting seat\'s concealed hand.',
    })
  }

  const tile = owner.concealedTiles[tileIndex]!
  const concealedTiles = [
    ...owner.concealedTiles.slice(0, tileIndex),
    ...owner.concealedTiles.slice(tileIndex + 1),
  ]
  const nextState = replaceSeat(state, { ...owner, concealedTiles })

  return accepted({
    ...nextState,
    discards: [...nextState.discards, { tile, discardedBy: action.seat, status: 'pending' }],
    currentDraw: null,
    phase: {
      kind: 'discard-responses',
      discarderSeat: action.seat,
      discardTileId: tile.tileId,
      responses: [],
    },
  })
}

function applyPass(
  state: EngineState,
  action: Extract<EngineAction, { kind: 'respond-to-discard' }>,
): EngineTransitionResult {
  if (state.phase.kind !== 'discard-responses') {
    return rejected({ code: 'invalid-action-for-phase', message: 'A pass requires a discard-response phase.' })
  }

  const responsePhase = state.phase
  const responses = [...responsePhase.responses, { seat: action.seat, choice: action.choice }]
  if (responses.length < 3) {
    return accepted({ ...state, phase: { ...responsePhase, responses } })
  }

  const discards = state.discards.map((discard) => discard.tile.tileId === responsePhase.discardTileId
    ? { ...discard, status: 'dead' as const }
    : discard)
  const actingSeat = nextSeat(responsePhase.discarderSeat)
  const acquisition = acquireTile({ ...state, discards }, actingSeat, 'front-wall')
  if (acquisition.state.phase.kind === 'ended') return accepted(acquisition.state)

  return accepted({
    ...acquisition.state,
    phase: { kind: 'player-action', actingSeat },
  })
}

export function applyEngineAction(state: EngineState, action: EngineAction): EngineTransitionResult {
  const compatibility = validateActionForPhase(state, action)
  if (!compatibility.accepted) return rejected(compatibility.error)

  if (action.kind === 'discard') return applyDiscard(state, action)
  if (action.kind === 'respond-to-discard') {
    if (action.choice.kind !== 'pass') {
      return rejected({
        code: 'illegal-action',
        message: 'Discard claims are not implemented; the only current response is pass.',
      })
    }
    return applyPass(state, action)
  }

  return rejected({
    code: 'illegal-action',
    message: `${action.kind} is not implemented as a legal player action.`,
  })
}
