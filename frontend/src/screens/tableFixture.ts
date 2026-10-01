import { RoomSnapshotSchema, type ActiveGameSnapshot, type FlowerIdentity, type Seat, type Suit } from '@cg-filipino-mahjong/shared'

const suited = (tileId: string, suit: Suit, rank: number) => ({ tileId, kind: 'suited' as const, suit, rank })
const flower = (tileId: string, identity: FlowerIdentity) => ({ tileId, kind: 'flower' as const, identity })

const suits: readonly Suit[] = ['sticks', 'balls', 'characters']
const discardSuit = (index: number): Suit => suits[index % suits.length]!
// Spread the 27 suited faces across the shared discard pile.
const discards = (seat: Seat, count: number) => Array.from({ length: count }, (_, index) => {
  const tileIndex = seat * 9 + index
  return suited(
    `preview-discard-${seat}-${index}`,
    suits[Math.floor(tileIndex / 9) % suits.length]!,
    (tileIndex % 9) + 1,
  )
})

const previewFlowers: readonly { readonly seat: Seat; readonly tileId: string; readonly identity: FlowerIdentity }[] = [
  { seat: 0, tileId: 'preview-flower-east', identity: 'east-wind' },
  { seat: 0, tileId: 'preview-flower-spring', identity: 'spring' },
  { seat: 0, tileId: 'preview-flower-south', identity: 'south-wind' },
  { seat: 0, tileId: 'preview-flower-west', identity: 'west-wind' },
  { seat: 0, tileId: 'preview-flower-north', identity: 'north-wind' },
  { seat: 1, tileId: 'preview-flower-summer', identity: 'summer' },
  { seat: 1, tileId: 'preview-flower-orchid', identity: 'orchid' },
  { seat: 1, tileId: 'preview-flower-green', identity: 'green-dragon' },
  { seat: 1, tileId: 'preview-flower-white', identity: 'white-dragon' },
  { seat: 1, tileId: 'preview-flower-autumn', identity: 'autumn' },
  { seat: 2, tileId: 'preview-flower-red', identity: 'red-dragon' },
  { seat: 3, tileId: 'preview-flower-bamboo', identity: 'bamboo' },
  { seat: 3, tileId: 'preview-flower-winter', identity: 'winter' },
  { seat: 3, tileId: 'preview-flower-plum', identity: 'plum' },
  { seat: 3, tileId: 'preview-flower-chrysanthemum', identity: 'chrysanthemum' },
]
const flowers = (seat: Seat) => previewFlowers
  .filter((tile) => tile.seat === seat)
  .map(({ tileId, identity }) => flower(tileId, identity))

const localTiles = Array.from({ length: 17 }, (_, index) => (
  suited(`preview-hand-${index}`, discardSuit(index), (index % 9) + 1)
))

export function createTableLayoutFixture(): ActiveGameSnapshot {
  const snapshot = RoomSnapshotSchema.parse({
  roomId: '00000000-0000-4000-8000-000000000501',
  roomCode: 'MJ2345',
  roomRevision: 18,
  visibility: 'public',
  readinessId: '00000000-0000-4000-8000-000000000502',
  spectatorCount: 0,
  self: { role: 'player', seat: 0, canControl: true },
  discards: [
    ...Array.from({ length: 14 }, (_, index) => ([0, 1, 2, 3] as const)
      .flatMap((seat) => discards(seat, [11, 14, 12, 10][seat]!).slice(index, index + 1))).flat(),
    suited('preview-latest-discard', 'characters', 9),
  ],
  seats: [
    {
      seat: 0,
      isDealer: true,
      controller: { kind: 'human', displayName: 'You', connection: 'connected', ready: true },
      concealedCount: 17,
      melds: [{
        meldId: '00000000-0000-4000-8000-000000000511',
        kind: 'secret',
        visibility: 'owner',
        tiles: [0, 1, 2, 3].map((copy) => suited(`preview-secret-local-${copy}`, 'sticks', 8)),
      }],
      flowers: flowers(0),
    },
    {
      seat: 1,
      isDealer: false,
      controller: { kind: 'human', displayName: 'Alexandria-Mari Santos', connection: 'connected', ready: true },
      concealedCount: 7,
      melds: [
        {
          meldId: '00000000-0000-4000-8000-000000000512',
          kind: 'open-kang',
          tiles: [0, 1, 2, 3].map((copy) => suited(`preview-kang-${copy}`, 'balls', 5)),
        },
        {
          meldId: '00000000-0000-4000-8000-000000000513',
          kind: 'chow',
          tiles: [2, 3, 4].map((rank) => suited(`preview-chow-${rank}`, 'characters', rank)),
        },
      ],
      flowers: flowers(1),
    },
    {
      seat: 2,
      isDealer: false,
      controller: { kind: 'bot' },
      concealedCount: 9,
      melds: [
        {
          meldId: '00000000-0000-4000-8000-000000000514',
          kind: 'pong',
          tiles: [0, 1, 2].map((copy) => suited(`preview-pong-${copy}`, 'sticks', 2)),
        },
        {
          meldId: '00000000-0000-4000-8000-000000000515',
          kind: 'secret',
          visibility: 'masked',
          tileCount: 4,
        },
      ],
      flowers: flowers(2),
    },
    {
      seat: 3,
      isDealer: false,
      controller: { kind: 'human', displayName: 'Luzviminda de la Cruz', connection: 'connected', ready: true },
      concealedCount: 10,
      melds: [{
        meldId: '00000000-0000-4000-8000-000000000516',
        kind: 'sagasa',
        tiles: [0, 1, 2, 3].map((copy) => suited(`preview-sagasa-${copy}`, 'characters', 7)),
      }],
      flowers: flowers(3),
    },
  ],
  pause: { isPaused: false, disconnectedSeats: [] },
  proposal: null,
  takeoverReservations: [],
  stage: 'playing',
  handId: '00000000-0000-4000-8000-000000000503',
  gameRevision: 36,
  wallRemainingCount: 42,
  phase: {
    phaseId: '00000000-0000-4000-8000-000000000504',
    kind: 'discard-responses',
    discarderSeat: 3,
    latestDiscard: suited('preview-latest-discard', 'characters', 9),
    respondedSeats: [0, 2],
  },
  privateState: {
    seat: 0,
    concealedTiles: localTiles,
    drawnTileId: 'preview-hand-16',
    legalChoices: [],
    hasResponded: true,
  },
  })

  if (snapshot.stage !== 'playing') throw new Error('The table preview must be an active-game snapshot.')

  return snapshot
}

export function createSpectatorTableFixture(): ActiveGameSnapshot {
  const playerView = createTableLayoutFixture()
  const snapshot = RoomSnapshotSchema.parse({
    ...playerView,
    spectatorCount: 2,
    self: { role: 'spectator', seat: null, canControl: false },
    seats: playerView.seats.map((seat) => ({
      ...seat,
      controller: seat.seat === 0 && seat.controller.kind === 'human'
        ? { ...seat.controller, displayName: 'Ana' }
        : seat.controller,
      melds: seat.melds.map((meld) => meld.kind === 'secret'
        ? { meldId: meld.meldId, kind: 'secret' as const, visibility: 'masked' as const, tileCount: 4 as const }
        : meld),
    })),
    privateState: null,
  })
  if (snapshot.stage !== 'playing') throw new Error('The spectator preview must be active play.')
  return snapshot
}

export function createHandArrangementFixture(count = 17): ActiveGameSnapshot {
  const layout = createTableLayoutFixture()
  const concealedTiles = layout.privateState!.concealedTiles.slice(0, count)
  const snapshot = RoomSnapshotSchema.parse({
    ...layout,
    seats: layout.seats.map((seat) => seat.seat === 0 ? { ...seat, concealedCount: count } : seat),
    phase: {
      phaseId: '00000000-0000-4000-8000-000000000601',
      kind: 'player-action',
      actingSeat: 0,
    },
    privateState: {
      ...layout.privateState!,
      hasResponded: false,
      concealedTiles,
      drawnTileId: concealedTiles.at(-1)!.tileId,
      legalChoices: concealedTiles.map((tile, index) => ({
        choiceId: `00000000-0000-4000-8000-${(700 + index).toString().padStart(12, '0')}`,
        kind: 'discard',
        tileId: tile.tileId,
      })),
    },
  })

  if (snapshot.stage !== 'playing') throw new Error('The hand arrangement preview must be active.')
  return snapshot
}

export function createClaimChoicesFixture(): ActiveGameSnapshot {
  const layout = createTableLayoutFixture()
  const concealed = [
    suited('claim-characters-6-a', 'characters', 6),
    suited('claim-characters-7-a', 'characters', 7),
    suited('claim-characters-7-b', 'characters', 7),
    suited('claim-characters-9-a', 'characters', 9),
    suited('claim-characters-8-a', 'characters', 8),
    suited('claim-characters-8-b', 'characters', 8),
    suited('claim-characters-8-c', 'characters', 8),
    ...layout.privateState!.concealedTiles.slice(7),
  ]
  const snapshot = RoomSnapshotSchema.parse({
    ...layout,
    discards: [...layout.discards.slice(0, -1), suited('claim-latest-characters-8', 'characters', 8)],
    phase: {
      phaseId: '00000000-0000-4000-8000-000000000801',
      kind: 'discard-responses',
      discarderSeat: 3,
      latestDiscard: suited('claim-latest-characters-8', 'characters', 8),
      respondedSeats: [2],
    },
    privateState: {
      ...layout.privateState!,
      concealedTiles: concealed,
      drawnTileId: null,
      hasResponded: false,
      legalChoices: [
        { choiceId: '00000000-0000-4000-8000-000000000811', kind: 'win', source: 'discard' },
        {
          choiceId: '00000000-0000-4000-8000-000000000812', kind: 'chow',
          concealedTileIds: ['claim-characters-6-a', 'claim-characters-7-a'],
        },
        {
          choiceId: '00000000-0000-4000-8000-000000000813', kind: 'chow',
          concealedTileIds: ['claim-characters-7-b', 'claim-characters-9-a'],
        },
        {
          choiceId: '00000000-0000-4000-8000-000000000814', kind: 'open-kang',
          concealedTileIds: ['claim-characters-8-a', 'claim-characters-8-b', 'claim-characters-8-c'],
        },
        {
          choiceId: '00000000-0000-4000-8000-000000000815', kind: 'pong',
          concealedTileIds: ['claim-characters-8-a', 'claim-characters-8-b'],
        },
        { choiceId: '00000000-0000-4000-8000-000000000816', kind: 'pass' },
      ],
    },
  })
  if (snapshot.stage !== 'playing') throw new Error('The claim preview must be active.')
  return snapshot
}

export function createSpecialActionsFixture(): ActiveGameSnapshot {
  const layout = createTableLayoutFixture()
  const pongMeldId = '00000000-0000-4000-8000-000000000821'
  const secretIds = ['special-sticks-4-a', 'special-sticks-4-b', 'special-sticks-4-c', 'special-sticks-4-d']
  const concealed = [
    ...secretIds.map((tileId) => suited(tileId, 'sticks', 4)),
    suited('special-balls-5-drawn', 'balls', 5),
    ...layout.privateState!.concealedTiles.slice(5),
  ]
  const seats = layout.seats.map((seat) => seat.seat === 0 ? {
    ...seat,
    melds: [
      ...seat.melds,
      {
        meldId: pongMeldId,
        kind: 'pong' as const,
        tiles: [0, 1, 2].map((copy) => suited(`special-balls-5-pong-${copy}`, 'balls', 5)),
      },
    ],
  } : seat)
  const snapshot = RoomSnapshotSchema.parse({
    ...layout,
    seats,
    phase: {
      phaseId: '00000000-0000-4000-8000-000000000802',
      kind: 'player-action',
      actingSeat: 0,
    },
    privateState: {
      ...layout.privateState!,
      concealedTiles: concealed,
      drawnTileId: 'special-balls-5-drawn',
      hasResponded: false,
      legalChoices: [
        ...concealed.map((tile, index) => ({
          choiceId: `00000000-0000-4000-8000-${(900 + index).toString().padStart(12, '0')}`,
          kind: 'discard', tileId: tile.tileId,
        })),
        { choiceId: '00000000-0000-4000-8000-000000000822', kind: 'win', source: 'self-draw' },
        {
          choiceId: '00000000-0000-4000-8000-000000000823', kind: 'secret',
          concealedTileIds: secretIds,
        },
        {
          choiceId: '00000000-0000-4000-8000-000000000824', kind: 'sagasa',
          meldId: pongMeldId,
          tileId: 'special-balls-5-drawn',
        },
      ],
    },
  })
  if (snapshot.stage !== 'playing') throw new Error('The special-action preview must be active.')
  return snapshot
}

/** Dense public information for layout checks, already projected for seat zero. */
export function createDenseMeldsFixture(): ActiveGameSnapshot {
  const base = createTableLayoutFixture()
  const concealedTiles = base.privateState!.concealedTiles.slice(0, 2)
  const snapshot = RoomSnapshotSchema.parse({
    ...base,
    seats: base.seats.map((seat) => ({
      ...seat,
      concealedCount: seat.seat === 0 ? 2 : 1,
      melds: [
        ...(['sticks', 'balls', 'characters'] as const).map((suit, index) => ({
          meldId: `00000000-0000-4000-8000-000000001${seat.seat}${index}0`,
          kind: 'pong',
          tiles: [0, 1, 2].map((copy) => suited(`dense-pong-${seat.seat}-${suit}-${copy}`, suit, seat.seat + 1)),
        })),
        {
          meldId: `00000000-0000-4000-8000-000000001${seat.seat}30`,
          kind: 'chow',
          tiles: [5, 6, 7].map((rank) => suited(`dense-chow-${seat.seat}-${rank}`, discardSuit(seat.seat), rank)),
        },
        seat.seat === 0 ? {
          meldId: '00000000-0000-4000-8000-000000001040',
          kind: 'secret', visibility: 'owner',
          tiles: [0, 1, 2, 3].map((copy) => suited(`dense-secret-local-${copy}`, 'sticks', 8)),
        } : seat.seat === 1 ? {
          meldId: '00000000-0000-4000-8000-000000001140',
          kind: 'open-kang',
          tiles: [0, 1, 2, 3].map((copy) => suited(`dense-kang-${copy}`, 'balls', 9)),
        } : {
          meldId: `00000000-0000-4000-8000-000000001${seat.seat}40`,
          kind: 'secret', visibility: 'masked', tileCount: 4,
        },
      ],
    })),
    phase: { kind: 'player-action', phaseId: base.phase.phaseId, actingSeat: 0 },
    privateState: {
      ...base.privateState!, concealedTiles, drawnTileId: concealedTiles[1]!.tileId, hasResponded: false,
      legalChoices: concealedTiles.map((tile, index) => ({
        choiceId: `00000000-0000-4000-8000-00000000150${index}`,
        kind: 'discard', tileId: tile.tileId,
      })),
    },
  })
  if (snapshot.stage !== 'playing') throw new Error('The dense meld preview must be active.')
  return snapshot
}
