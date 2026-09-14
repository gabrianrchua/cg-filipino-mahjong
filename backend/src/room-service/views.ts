import {
  RoomSnapshotSchema,
  type LegalChoice,
  type RoomSnapshot,
  type Seat,
  type SeatController,
  type SeatView,
} from '@cg-filipino-mahjong/shared'

import { projectMeldsForRecipient } from '../game-engine/index.js'
import type { EngineState } from '../game-engine/model.js'
import type { RoomSeatController, RoomState } from './model.js'

function projectController(controller: RoomSeatController): SeatController {
  if (controller.kind !== 'human') return { kind: controller.kind }
  return {
    kind: 'human',
    displayName: controller.displayName,
    connection: controller.connected ? 'connected' : 'disconnected',
    ready: controller.ready,
  }
}

function dealerFor(room: RoomState): Seat | null {
  if (room.stage.kind === 'waiting') return null
  if (room.stage.kind === 'between-hands') return room.stage.engineState.phase.kind === 'ended'
    ? room.stage.engineState.phase.result.nextDealerSeat
    : null
  return room.stage.engineState.dealerSeat
}

function projectSeats(room: RoomState, recipientSeat: Seat): readonly SeatView[] {
  const state = room.stage.kind === 'waiting' ? null : room.stage.engineState
  const dealerSeat = dealerFor(room)
  return room.seats.map((roomSeat): SeatView => {
    const engineSeat = state?.seats[roomSeat.seat]
    return {
      seat: roomSeat.seat,
      isDealer: dealerSeat === roomSeat.seat,
      controller: projectController(roomSeat.controller),
      concealedCount: engineSeat?.concealedTiles.length ?? 0,
      melds: engineSeat ? [...projectMeldsForRecipient(engineSeat, recipientSeat)] : [],
      flowers: engineSeat ? [...engineSeat.flowers] : [],
      discards: state
        ? state.discards
          .filter((discard) => discard.discardedBy === roomSeat.seat)
          .map((discard) => discard.tile)
        : [],
    }
  })
}

function projectPhase(state: EngineState, phaseId: string) {
  const phase = state.phase
  if (phase.kind === 'setup') return { phaseId, kind: 'setup' as const }
  if (phase.kind === 'player-action') {
    return { phaseId, kind: 'player-action' as const, actingSeat: phase.actingSeat }
  }
  if (phase.kind === 'ended') throw new Error('An ended engine phase cannot be projected as active play.')
  const latestDiscard = state.discards.find((discard) => discard.tile.tileId === phase.discardTileId)
  if (!latestDiscard) throw new Error('The active discard response has no matching discard.')
  return {
    phaseId,
    kind: 'discard-responses' as const,
    discarderSeat: phase.discarderSeat,
    latestDiscard: latestDiscard.tile,
    respondedSeats: phase.responses.map((response) => response.seat),
  }
}

/** Builds a recipient-specific snapshot using only fields allowed by the shared wire contract. */
export function projectRoomSnapshot(
  room: RoomState,
  recipientSeat: Seat,
  legalChoices: readonly LegalChoice[] = [],
): RoomSnapshot {
  const common = {
    roomId: room.roomId,
    roomCode: room.roomCode,
    roomRevision: room.roomRevision,
    visibility: room.visibility,
    readinessId: room.readinessId,
    self: { seat: recipientSeat, canControl: true },
    seats: projectSeats(room, recipientSeat),
    pause: {
      isPaused: room.seats.some((seat) => seat.controller.kind === 'human' && !seat.controller.connected),
      disconnectedSeats: room.seats
        .filter((seat) => seat.controller.kind === 'human' && !seat.controller.connected)
        .map((seat) => seat.seat),
    },
    proposal: room.proposal,
    takeoverReservations: [],
  }

  if (room.stage.kind === 'waiting') {
    return RoomSnapshotSchema.parse({ ...common, stage: 'waiting' })
  }

  const state = room.stage.engineState
  if (room.stage.kind === 'between-hands') {
    if (state.phase.kind !== 'ended') throw new Error('A between-hands room must contain an ended engine state.')
    return RoomSnapshotSchema.parse({
      ...common,
      stage: 'between-hands',
      handId: room.stage.handId,
      gameRevision: room.stage.gameRevision,
      result: state.phase.result,
    })
  }

  if (state.phase.kind === 'ended') throw new Error('A playing room cannot contain an ended engine state.')
  const recipient = state.seats[recipientSeat]
  return RoomSnapshotSchema.parse({
    ...common,
    stage: 'playing',
    handId: room.stage.handId,
    gameRevision: room.stage.gameRevision,
    wallRemainingCount: state.wall.remainingTiles.length,
    phase: projectPhase(state, room.stage.phaseId),
    privateState: {
      seat: recipientSeat,
      concealedTiles: [...recipient.concealedTiles],
      drawnTileId: state.currentDraw?.seat === recipientSeat ? state.currentDraw.tileId : null,
      legalChoices: [...legalChoices],
      hasResponded: state.phase.kind === 'discard-responses'
        && state.phase.responses.some((response) => response.seat === recipientSeat),
    },
  })
}
