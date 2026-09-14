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
