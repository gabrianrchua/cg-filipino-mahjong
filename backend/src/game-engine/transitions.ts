import { randomUUID } from 'node:crypto'

import { MeldIdSchema, type MeldId, type Seat, type TileId } from '@cg-filipino-mahjong/shared'

import {
  chooseResolvedResponse,
  getDiscardResponseActions,
  meldChoiceTiles,
  validateDiscardResponseChoice,
} from './claims.js'
import { acquireTile, completeInitialSetup } from './draws.js'
import { validateEngineState } from './invariants.js'
import type {
  EngineAction,
  EngineError,
  EngineState,
  EngineTile,
  EngineTransitionResult,
  FourTileTuple,
  FourSeatStates,
  SeatState,
  ThreeTileTuple,
} from './model.js'
import {
  chooseDealer,
  createCanonicalTileSet,
  nextSeat,
  shuffleTiles,
  systemRandomSource,
  type RandomSource,
} from './tiles.js'
import { findWinningDecomposition } from './wins.js'

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

export type InitializeNextHandOptions = Omit<InitializeHandOptions, 'dealerSeat'>

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

export function initializeNextHand(
  previousHand: EngineState,
  options: InitializeNextHandOptions = {},
): EngineTransitionResult {
  const issues = validateEngineState(previousHand)
  if (issues.length > 0) {
    return rejected({ code: 'invalid-state', message: 'Cannot initialize from an invalid engine state.', issues })
  }
  if (previousHand.phase.kind !== 'ended') {
    return rejected({
      code: 'invalid-action-for-phase',
      message: 'The next hand can be initialized only after the previous hand has ended.',
    })
  }
  return initializeHand({ ...options, dealerSeat: previousHand.phase.result.nextDealerSeat })
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
    const owner = state.seats[seat]!
    const win = state.currentDraw?.seat === seat
      && findWinningDecomposition(owner.concealedTiles, owner.melds) !== null
      ? [{ kind: 'win' as const, seat }]
      : []
    return Object.freeze([...win, ...owner.concealedTiles.map((tile) => ({
      kind: 'discard' as const,
      seat,
      tileId: tile.tileId,
    }))])
  }

  if (
    state.phase.kind === 'discard-responses'
    && state.phase.discarderSeat !== seat
    && !state.phase.responses.some((response) => response.seat === seat)
  ) {
    return getDiscardResponseActions(state, state.phase, seat)
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

function applyDiscardResponse(
  state: EngineState,
  action: Extract<EngineAction, { kind: 'respond-to-discard' }>,
  options: ApplyEngineActionOptions,
): EngineTransitionResult {
  if (state.phase.kind !== 'discard-responses') {
    return rejected({ code: 'invalid-action-for-phase', message: 'A pass requires a discard-response phase.' })
  }

  const responsePhase = state.phase
  const pendingDiscard = state.discards.find((discard) => discard.tile.tileId === responsePhase.discardTileId)
  if (!pendingDiscard) {
    return rejected({ code: 'invalid-state', message: 'The response phase has no matching pending discard.' })
  }
  const choiceError = validateDiscardResponseChoice(state, responsePhase, action.seat, action.choice)
  if (choiceError) return rejected({ code: 'illegal-action', message: choiceError })

  const responses = [...responsePhase.responses, { seat: action.seat, choice: action.choice }]
  if (responses.length < 3) {
    return accepted({ ...state, phase: { ...responsePhase, responses } })
  }

  const resolved = chooseResolvedResponse(responsePhase, responses)
  if (resolved?.choice.kind === 'win') {
    const winnerSeat = resolved.seat
    const winner = state.seats[winnerSeat]!
    const concealedTiles = [...winner.concealedTiles, pendingDiscard.tile]
    const decomposition = findWinningDecomposition(concealedTiles, winner.melds)
    if (decomposition === null) {
      return rejected({ code: 'invalid-state', message: 'A submitted winning response no longer forms a winning hand.' })
    }
    const claimedState = replaceSeat(state, { ...winner, concealedTiles })
    return accepted({
      ...claimedState,
      discards: claimedState.discards.filter((discard) => discard.tile.tileId !== pendingDiscard.tile.tileId),
      currentDraw: null,
      phase: {
        kind: 'ended',
        result: {
          kind: 'win',
          winnerSeat,
          source: 'discard',
          winningTile: pendingDiscard.tile,
          decomposition,
          nextDealerSeat: winnerSeat === state.dealerSeat ? state.dealerSeat : nextSeat(state.dealerSeat),
        },
      },
    })
  }

  if (resolved && resolved.choice.kind !== 'pass') {
    const choice = resolved.choice
    const claimant = state.seats[resolved.seat]!
    const selectedIds = new Set<TileId>(choice.concealedTileIds)
    const concealedTiles = claimant.concealedTiles.filter((tile) => !selectedIds.has(tile.tileId))
    const meldTiles = meldChoiceTiles(state, responsePhase, resolved.seat, choice)
    let meldId: MeldId
    try {
      meldId = (options.createMeldId ?? randomUUID)()
    } catch (error) {
      return rejected({
        code: 'invalid-meld-id',
        message: error instanceof Error ? error.message : 'The meld ID factory failed.',
      })
    }
    if (
      !MeldIdSchema.safeParse(meldId).success
      || state.seats.some((seat) => seat.melds.some((meld) => meld.meldId === meldId))
    ) {
      return rejected({ code: 'invalid-meld-id', message: 'The meld ID factory must return a new UUID.' })
    }

    const meld = choice.kind === 'open-kang'
      ? { meldId, kind: choice.kind, tiles: meldTiles as FourTileTuple }
      : { meldId, kind: choice.kind, tiles: meldTiles as ThreeTileTuple }
    const claimedState = replaceSeat(state, {
      ...claimant,
      concealedTiles,
      melds: [...claimant.melds, meld],
    })
    const withoutDiscard: EngineState = {
      ...claimedState,
      discards: claimedState.discards.filter((discard) => discard.tile.tileId !== pendingDiscard.tile.tileId),
      currentDraw: null,
    }

    if (choice.kind === 'open-kang') {
      const acquisition = acquireTile(withoutDiscard, resolved.seat, 'gift')
      if (acquisition.state.phase.kind === 'ended') return accepted(acquisition.state)
      return accepted({
        ...acquisition.state,
        phase: { kind: 'player-action', actingSeat: resolved.seat },
      })
    }
    return accepted({
      ...withoutDiscard,
      phase: { kind: 'player-action', actingSeat: resolved.seat },
    })
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

function applySelfDrawWin(
  state: EngineState,
  action: Extract<EngineAction, { kind: 'win' }>,
): EngineTransitionResult {
  const draw = state.currentDraw
  if (draw?.seat !== action.seat) {
    return rejected({ code: 'illegal-action', message: 'A self-drawn win requires the acting seat\'s current drawn tile.' })
  }
  const winner = state.seats[action.seat]!
  const winningTile = winner.concealedTiles.find((tile) => tile.tileId === draw.tileId)
  const decomposition = findWinningDecomposition(winner.concealedTiles, winner.melds)
  if (!winningTile || decomposition === null) {
    return rejected({ code: 'illegal-action', message: 'The current drawn tile does not complete this seat\'s hand.' })
  }

  return accepted({
    ...state,
    phase: {
      kind: 'ended',
      result: {
        kind: 'win',
        winnerSeat: action.seat,
        source: 'self-draw',
        winningTile,
        decomposition,
        nextDealerSeat: action.seat === state.dealerSeat ? state.dealerSeat : nextSeat(state.dealerSeat),
      },
    },
  })
}

export function abortHand(state: EngineState): EngineTransitionResult {
  const issues = validateEngineState(state)
  if (issues.length > 0) {
    return rejected({ code: 'invalid-state', message: 'Cannot abort an invalid engine state.', issues })
  }
  if (state.phase.kind === 'ended') {
    return rejected({ code: 'invalid-action-for-phase', message: 'An ended hand cannot be aborted.' })
  }
  return accepted({
    ...state,
    discards: state.discards.map((discard) => discard.status === 'pending'
      ? { ...discard, status: 'dead' as const }
      : discard),
    currentDraw: null,
    phase: {
      kind: 'ended',
      result: { kind: 'abort', nextDealerSeat: state.dealerSeat },
    },
  })
}

export interface ApplyEngineActionOptions {
  readonly createMeldId?: () => MeldId
}

export function applyEngineAction(
  state: EngineState,
  action: EngineAction,
  options: ApplyEngineActionOptions = {},
): EngineTransitionResult {
  const compatibility = validateActionForPhase(state, action)
  if (!compatibility.accepted) return rejected(compatibility.error)

  if (action.kind === 'discard') return applyDiscard(state, action)
  if (action.kind === 'win') return applySelfDrawWin(state, action)
  if (action.kind === 'respond-to-discard') {
    return applyDiscardResponse(state, action, options)
  }

  return rejected({
    code: 'illegal-action',
    message: `${action.kind} is not implemented as a legal player action.`,
  })
}
