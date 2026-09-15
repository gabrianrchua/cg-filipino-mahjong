import { RoomSnapshotSchema, type ActiveGameSnapshot, type FlowerIdentity, type Seat, type Suit } from '@cg-filipino-mahjong/shared'

const suited = (tileId: string, suit: Suit, rank: number) => ({ tileId, kind: 'suited' as const, suit, rank })
const flower = (tileId: string, identity: FlowerIdentity) => ({ tileId, kind: 'flower' as const, identity })

const discardSuit = (index: number): Suit => (['sticks', 'balls', 'characters'] as const)[index % 3]!
const discards = (seat: Seat, count: number) => Array.from({ length: count }, (_, index) => (
  suited(`preview-discard-${seat}-${index}`, discardSuit(index), (index % 9) + 1)
))

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
  self: { seat: 0, canControl: true },
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
      flowers: [flower('preview-flower-east', 'east-wind'), flower('preview-flower-spring', 'spring')],
      discards: discards(0, 11),
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
      flowers: [flower('preview-flower-summer', 'summer'), flower('preview-flower-orchid', 'orchid')],
      discards: discards(1, 14),
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
      flowers: [flower('preview-flower-red', 'red-dragon')],
      discards: discards(2, 12),
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
      flowers: [flower('preview-flower-bamboo', 'bamboo')],
      discards: [...discards(3, 10), suited('preview-latest-discard', 'characters', 9)],
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

export function createHandArrangementFixture(): ActiveGameSnapshot {
  const layout = createTableLayoutFixture()
  const snapshot = RoomSnapshotSchema.parse({
    ...layout,
    phase: {
      phaseId: '00000000-0000-4000-8000-000000000601',
      kind: 'player-action',
      actingSeat: 0,
    },
    privateState: {
      ...layout.privateState!,
      hasResponded: false,
      legalChoices: layout.privateState!.concealedTiles.map((tile, index) => ({
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
