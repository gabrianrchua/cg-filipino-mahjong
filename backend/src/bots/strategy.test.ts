import {
  ACTIVE_LOCAL_TURN_FIXTURE,
  RoomSnapshotSchema,
  WAITING_ROOM_FIXTURE,
  type LegalChoice,
  type RoomSnapshot,
  type Suit,
} from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

import type { RandomSource } from '../game-engine/index.js'
import { chooseBotLegalChoice, scoreHandBuildingPotential } from './strategy.js'

const UUID_PREFIX = '00000000-0000-4000-8000-'
const choiceId = (suffix: number) => `${UUID_PREFIX}${suffix.toString().padStart(12, '0')}`
const tile = (tileId: string, suit: Suit, rank: number) => ({
  tileId,
  kind: 'suited' as const,
  suit,
  rank,
})

const firstRandom: RandomSource = { nextInt: () => 0 }

function snapshot(
  phase: 'player-action' | 'discard-responses',
  concealedTiles: ReturnType<typeof tile>[],
  legalChoices: LegalChoice[],
): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    ...ACTIVE_LOCAL_TURN_FIXTURE,
    phase: phase === 'player-action'
      ? { phaseId: choiceId(800), kind: phase, actingSeat: 0 }
      : {
          phaseId: choiceId(801),
          kind: phase,
          discarderSeat: 3,
          latestDiscard: tile('discarded', 'balls', 9),
          respondedSeats: [],
        },
    privateState: {
      seat: 0,
      concealedTiles,
      drawnTileId: null,
      legalChoices,
      hasResponded: false,
    },
  })
}

describe('chooseBotLegalChoice', () => {
  it('returns null outside active play or without private state', () => {
    expect(chooseBotLegalChoice(WAITING_ROOM_FIXTURE, firstRandom)).toBeNull()
    expect(chooseBotLegalChoice(RoomSnapshotSchema.parse({
      ...ACTIVE_LOCAL_TURN_FIXTURE,
      privateState: null,
    }), firstRandom)).toBeNull()
  })

  it('always prefers either kind of legal win', () => {
    for (const source of ['self-draw', 'discard'] as const) {
      const win = { choiceId: choiceId(source === 'self-draw' ? 1 : 2), kind: 'win' as const, source }
      const view = snapshot(
        source === 'self-draw' ? 'player-action' : 'discard-responses',
        [tile('a', 'sticks', 1)],
        [
          { choiceId: choiceId(3), kind: 'discard', tileId: 'a' },
          { choiceId: choiceId(4), kind: 'open-kang', concealedTileIds: ['a', 'b', 'c'] },
          win,
        ],
      )
      expect(chooseBotLegalChoice(view, firstRandom)?.choiceId).toBe(win.choiceId)
    }
  })

  it('uses sagasa, secret, then discard priority during player action', () => {
    const concealed = [
      tile('a', 'sticks', 1), tile('b', 'sticks', 1), tile('c', 'sticks', 1), tile('d', 'sticks', 1),
    ]
    const discard = { choiceId: choiceId(10), kind: 'discard' as const, tileId: 'a' }
    const secret = { choiceId: choiceId(11), kind: 'secret' as const, concealedTileIds: ['a', 'b', 'c', 'd'] as [string, string, string, string] }
    const sagasa = { choiceId: choiceId(12), kind: 'sagasa' as const, meldId: choiceId(13), tileId: 'd' }
    expect(chooseBotLegalChoice(snapshot('player-action', concealed, [discard, secret, sagasa]), firstRandom)?.choiceId).toBe(sagasa.choiceId)
    expect(chooseBotLegalChoice(snapshot('player-action', concealed, [discard, secret]), firstRandom)?.choiceId).toBe(secret.choiceId)
    expect(chooseBotLegalChoice(snapshot('player-action', concealed, [discard]), firstRandom)?.choiceId).toBe(discard.choiceId)
  })

  it('uses open-kang, pong, chow, then pass priority during responses', () => {
    const concealed = [tile('a', 'balls', 2), tile('b', 'balls', 2), tile('c', 'balls', 2)]
    const pass = { choiceId: choiceId(20), kind: 'pass' as const }
    const chow = { choiceId: choiceId(21), kind: 'chow' as const, concealedTileIds: ['a', 'b'] as [string, string] }
    const pong = { choiceId: choiceId(22), kind: 'pong' as const, concealedTileIds: ['a', 'b'] as [string, string] }
    const kang = { choiceId: choiceId(23), kind: 'open-kang' as const, concealedTileIds: ['a', 'b', 'c'] as [string, string, string] }
    expect(chooseBotLegalChoice(snapshot('discard-responses', concealed, [pass, chow, pong, kang]), firstRandom)?.choiceId).toBe(kang.choiceId)
    expect(chooseBotLegalChoice(snapshot('discard-responses', concealed, [pass, chow, pong]), firstRandom)?.choiceId).toBe(pong.choiceId)
    expect(chooseBotLegalChoice(snapshot('discard-responses', concealed, [pass, chow]), firstRandom)?.choiceId).toBe(chow.choiceId)
    expect(chooseBotLegalChoice(snapshot('discard-responses', concealed, [pass]), firstRandom)?.choiceId).toBe(pass.choiceId)
  })

  it('chooses the action that leaves the strongest concealed hand', () => {
    const isolated = tile('isolated', 'characters', 9)
    const connected = tile('connected', 'sticks', 2)
    const choices: LegalChoice[] = [
      { choiceId: choiceId(30), kind: 'discard', tileId: connected.tileId },
      { choiceId: choiceId(31), kind: 'discard', tileId: isolated.tileId },
    ]
    const view = snapshot('player-action', [tile('one', 'sticks', 1), connected, isolated], choices)
    expect(chooseBotLegalChoice(view, firstRandom)?.choiceId).toBe(choices[1]?.choiceId)
  })

  it('uses injected randomness only for exact best-score ties', () => {
    const choices: LegalChoice[] = [
      { choiceId: choiceId(40), kind: 'discard', tileId: 'a' },
      { choiceId: choiceId(41), kind: 'discard', tileId: 'b' },
    ]
    let maximum: number | undefined
    const random: RandomSource = { nextInt: (value) => { maximum = value; return 1 } }
    const selected = chooseBotLegalChoice(snapshot('player-action', [
      tile('a', 'sticks', 1), tile('b', 'balls', 9),
    ], choices), random)
    expect(selected?.choiceId).toBe(choices[1]?.choiceId)
    expect(maximum).toBe(2)

    const unequalChoices: LegalChoice[] = [
      { choiceId: choiceId(42), kind: 'discard', tileId: 'a' },
      { choiceId: choiceId(43), kind: 'discard', tileId: 'c' },
    ]
    maximum = undefined
    chooseBotLegalChoice(snapshot('player-action', [
      tile('a', 'sticks', 1), tile('b', 'sticks', 2), tile('c', 'characters', 9),
    ], unequalChoices), random)
    expect(maximum).toBeUndefined()
  })

  it('returns the supplied choice object and does not mutate the snapshot', () => {
    const view = snapshot('player-action', [tile('a', 'sticks', 1)], [
      { choiceId: choiceId(50), kind: 'discard', tileId: 'a' },
    ])
    const before = JSON.stringify(view)
    const selected = chooseBotLegalChoice(view, firstRandom)
    if (view.stage !== 'playing') throw new Error('Expected a playing snapshot')
    expect(selected).toBe(view.privateState?.legalChoices[0])
    expect(JSON.stringify(view)).toBe(before)
  })
})

describe('scoreHandBuildingPotential', () => {
  it('scores all unordered same-suit pairs using 3/2/1 weights', () => {
    expect(scoreHandBuildingPotential([
      tile('1a', 'sticks', 1),
      tile('1b', 'sticks', 1),
      tile('2', 'sticks', 2),
      tile('3', 'sticks', 3),
      tile('other-suit', 'balls', 1),
    ])).toBe(11)
  })
})
