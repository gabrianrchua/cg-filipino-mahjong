import type { GameplayAction, LegalChoice, RoomSnapshot, Seat } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import {
  initializeHand,
  validateEngineState,
  type EngineState,
  type RandomSource,
} from '../game-engine/index.js'
import {
  RoomService,
  type RoomServiceResult,
} from '../room-service/index.js'
import { chooseBotChoice } from './strategy.js'

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0
  return {
    nextInt: (maximum) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      return state % maximum
    },
  }
}

function unwrap<T>(result: RoomServiceResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

function commandFor(choice: LegalChoice): GameplayAction {
  return choice.kind === 'discard' || (choice.kind === 'win' && choice.source === 'self-draw') || choice.kind === 'secret' || choice.kind === 'sagasa'
    ? { kind: choice.kind, choiceId: choice.choiceId }
    : { kind: 'respond-to-discard', choiceId: choice.choiceId }
}

function expectConserved(state: EngineState): void {
  const located = [
    ...state.wall.remainingTiles,
    ...state.seats.flatMap((seat) => [
      ...seat.concealedTiles,
      ...seat.flowers,
      ...seat.melds.flatMap((meld) => meld.tiles),
    ]),
    ...state.discards.map((discard) => discard.tile),
  ]
  expect(located).toHaveLength(state.tileUniverse.length)
  expect(new Set(located.map((tile) => tile.tileId)).size).toBe(state.tileUniverse.length)
  expect(validateEngineState(state)).toEqual([])
}

describe('seeded bot simulations', () => {
  it.each([7, 29, 101])('plays a conserved legal hand with one connected human (seed %i)', (seed) => {
    const wallRandom = seededRandom(seed)
    const decisionRandom = seededRandom(seed ^ 0x9e3779b9)
    const service = new RoomService({
      initializeHand: () => initializeHand({ dealerSeat: (seed % 4) as Seat, randomSource: wallRandom }),
    })
    const session = unwrap(service.bootstrapSession('Human Fixture', `socket-${seed}`))
    let room = unwrap(service.createRoom(session.control, 'unlisted'))
    for (const seat of [1, 2, 3] as const) {
      room = unwrap(service.configureSeat(session.control, room.roomId, room.roomRevision, seat, 'bot'))
    }
    room = unwrap(service.setReady(session.control, room.roomId, room.readinessId, true))

    let transitions = 0
    while (room.stage.kind === 'playing' && transitions < 1_000) {
      expectConserved(room.stage.engineState)
      let acted = false
      for (const seat of [0, 1, 2, 3] as const) {
        const projected: RoomServiceResult<RoomSnapshot> = seat === 0
          ? service.getRecipientSnapshot(session.control, room.roomId)
          : service.getBotDecisionSnapshot(room.roomId, seat)
        if (!projected.ok || projected.value.stage !== 'playing') continue
        const choice = chooseBotChoice(projected.value, decisionRandom)
        if (!choice) continue
        expect(projected.value.privateState?.legalChoices).toContain(choice)
        room = seat === 0
          ? unwrap(service.applyGameAction(session.control, {
              roomId: room.roomId,
              handId: projected.value.handId,
              phaseId: projected.value.phase.phaseId,
              action: commandFor(choice),
            }))
          : unwrap(service.applyBotGameAction({
              roomId: room.roomId,
              seat,
              handId: projected.value.handId,
              phaseId: projected.value.phase.phaseId,
              choiceId: choice.choiceId,
            }))
        transitions += 1
        acted = true
        break
      }
      if (!acted) throw new Error('An active hand has no legal controller action.')
    }

    expect(transitions).toBeLessThan(1_000)
    expect(room.stage.kind).toBe('between-hands')
    if (room.stage.kind === 'between-hands') expectConserved(room.stage.engineState)
  })
})
