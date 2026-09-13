import type { Seat, SuitedTile } from '@cg-filipino-mahjong/shared'

import type {
  DrawSource,
  EngineState,
  EngineTile,
  FourSeatStates,
  SeatState,
} from './model.js'
import { nextSeat } from './tiles.js'

type WallEnd = 'front' | 'back'

export interface AutomaticTileAcquisition {
  readonly state: EngineState
  readonly tile: SuitedTile | null
}

function replaceSeat(state: EngineState, replacement: SeatState): EngineState {
  const seats = state.seats.map((seat) => seat.seat === replacement.seat ? replacement : seat) as unknown as FourSeatStates
  return { ...state, seats }
}

function takeTile(state: EngineState, end: WallEnd): { readonly state: EngineState; readonly tile: EngineTile } | null {
  const remainingTiles = state.wall.remainingTiles
  if (remainingTiles.length === 0) return null

  const tile = end === 'front' ? remainingTiles[0]! : remainingTiles[remainingTiles.length - 1]!
  const nextRemaining = end === 'front' ? remainingTiles.slice(1) : remainingTiles.slice(0, -1)
  return { state: { ...state, wall: { remainingTiles: nextRemaining } }, tile }
}

function receiveTile(state: EngineState, seat: Seat, tile: EngineTile): EngineState {
  const owner = state.seats[seat]!
  return replaceSeat(state, tile.kind === 'flower'
    ? { ...owner, flowers: [...owner.flowers, tile] }
    : { ...owner, concealedTiles: [...owner.concealedTiles, tile] })
}

function endForExhaustion(state: EngineState): EngineState {
  return {
    ...state,
    currentDraw: null,
    phase: {
      kind: 'ended',
      result: { kind: 'exhaustion-draw', nextDealerSeat: nextSeat(state.dealerSeat) },
    },
  }
}

/**
 * Draw until a suited tile is received. This is an atomic-transition building block:
 * callers own phase changes and validation around the temporary hand shape.
 */
export function acquireTile(
  input: EngineState,
  seat: Seat,
  source: DrawSource | null,
): AutomaticTileAcquisition {
  let state = input
  let end: WallEnd = source === 'front-wall' ? 'front' : 'back'

  while (true) {
    const draw = takeTile(state, end)
    if (draw === null) return { state: endForExhaustion(state), tile: null }

    state = receiveTile(draw.state, seat, draw.tile)
    if (draw.tile.kind === 'suited') {
      if (source !== null) {
        state = { ...state, currentDraw: { seat, tileId: draw.tile.tileId, source } }
      }
      return { state, tile: draw.tile }
    }

    end = 'back'
  }
}

interface PendingReplacement {
  readonly seat: Seat
  readonly isDealerOpening: boolean
}

function receiveInitialTile(
  state: EngineState,
  seat: Seat,
  isDealerOpening: boolean,
  pending: PendingReplacement[],
): EngineState {
  const draw = takeTile(state, 'front')
  if (draw === null) return endForExhaustion(state)

  const received = receiveTile(draw.state, seat, draw.tile)
  if (draw.tile.kind === 'flower') {
    pending.push({ seat, isDealerOpening })
    return received
  }
  return isDealerOpening
    ? { ...received, currentDraw: { seat, tileId: draw.tile.tileId, source: 'dealer-opening' } }
    : received
}

export function completeInitialSetup(input: EngineState): EngineState {
  let state = input
  const order = [
    state.dealerSeat,
    nextSeat(state.dealerSeat),
    nextSeat(nextSeat(state.dealerSeat)),
    nextSeat(nextSeat(nextSeat(state.dealerSeat))),
  ] as const
  const pending: PendingReplacement[] = []

  for (let round = 0; round < 2; round += 1) {
    for (const seat of order) {
      for (let tileNumber = 0; tileNumber < 8; tileNumber += 1) {
        state = receiveInitialTile(state, seat, false, pending)
        if (state.phase.kind === 'ended') return state
      }
    }
  }

  state = receiveInitialTile(state, state.dealerSeat, true, pending)
  if (state.phase.kind === 'ended') return state

  for (const seat of order) {
    for (const replacement of pending.filter((entry) => entry.seat === seat)) {
      const result = acquireTile(
        state,
        seat,
        replacement.isDealerOpening ? 'dealer-opening' : null,
      )
      state = result.state
      if (state.phase.kind === 'ended') return state
    }
  }

  return { ...state, phase: { kind: 'player-action', actingSeat: state.dealerSeat } }
}
