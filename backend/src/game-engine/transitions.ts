import type { Seat } from '@cg-filipino-mahjong/shared'

import { validateEngineState } from './invariants.js'
import type {
  EngineAction,
  EngineError,
  EngineState,
  EngineTile,
  EngineTransitionResult,
  FourSeatStates,
} from './model.js'
import {
  chooseDealer,
  createCanonicalTileSet,
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

  const state: EngineState = {
    dealerSeat,
    seats: seats(),
    wall: { remainingTiles: wall },
    discards: Object.freeze([]),
    currentDraw: null,
    phase: { kind: 'setup' },
  }
  const issues = validateEngineState(state)
  if (issues.length > 0) {
    return rejected({ code: 'invalid-wall', message: 'Initial wall is not a canonical 144-tile set.', issues })
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
