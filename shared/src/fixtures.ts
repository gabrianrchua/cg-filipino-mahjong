import type { z } from 'zod'

import { LobbySummarySchema, RoomEntrySummarySchema, RoomSnapshotSchema } from './views.js'

const IDS = {
  room: '00000000-0000-4000-8000-000000000001',
  hand: '00000000-0000-4000-8000-000000000002',
  readiness: '00000000-0000-4000-8000-000000000003',
  phaseAction: '00000000-0000-4000-8000-000000000004',
  phaseClaim: '00000000-0000-4000-8000-000000000005',
  proposal: '00000000-0000-4000-8000-000000000006',
  takeover: '00000000-0000-4000-8000-000000000007',
  meld: '00000000-0000-4000-8000-000000000008',
  choice: '00000000-0000-4000-8000-000000000009',
} as const

const suited = (tileId: string, suit: 'sticks' | 'balls' | 'characters', rank: number) => ({
  tileId,
  kind: 'suited' as const,
  suit,
  rank,
})

const flower = {
  tileId: 'flower-east-1',
  kind: 'flower' as const,
  identity: 'east-wind' as const,
}

const openPong = {
  meldId: IDS.meld,
  kind: 'pong' as const,
  tiles: [
    suited('balls-5-a', 'balls', 5),
    suited('balls-5-b', 'balls', 5),
    suited('balls-5-c', 'balls', 5),
  ],
}

const maskedSecret = {
  meldId: '00000000-0000-4000-8000-000000000018',
  kind: 'secret' as const,
  visibility: 'masked' as const,
  tileCount: 4 as const,
}

const revealedSecret = {
  meldId: '00000000-0000-4000-8000-000000000018',
  kind: 'secret' as const,
  visibility: 'owner' as const,
  tiles: [
    suited('sticks-8-a', 'sticks', 8),
    suited('sticks-8-b', 'sticks', 8),
    suited('sticks-8-c', 'sticks', 8),
    suited('sticks-8-d', 'sticks', 8),
  ],
}

const seatControllers = [
  { kind: 'human' as const, displayName: 'Ana', connection: 'connected' as const, ready: false },
  { kind: 'human' as const, displayName: 'Ben', connection: 'connected' as const, ready: false },
  { kind: 'bot' as const },
  { kind: 'human' as const, displayName: 'Cora', connection: 'connected' as const, ready: false },
]

function seatsFor(recipient: 0 | 1, stage: 'waiting' | 'playing' | 'between-hands') {
  return ([0, 1, 2, 3] as const).map((seat) => ({
    seat,
    isDealer: seat === 0,
    controller: seatControllers[seat],
    concealedCount: stage === 'waiting' ? 0 : seat === 1 ? 9 : 13,
    melds: stage === 'waiting'
      ? []
      : seat === 0
        ? [openPong]
        : seat === 1
          ? [recipient === 1 ? revealedSecret : maskedSecret]
          : [],
    flowers: stage === 'waiting' || seat !== 0 ? [] : [flower],
    discards: stage === 'waiting' || seat !== 3
      ? []
      : [suited('characters-9-a', 'characters', 9)],
  }))
}

const base = (recipient: 0 | 1, stage: 'waiting' | 'playing' | 'between-hands') => ({
  roomId: IDS.room,
  roomCode: 'MJ2345',
  roomRevision: 8,
  visibility: 'public' as const,
  readinessId: IDS.readiness,
  self: { seat: recipient, canControl: true },
  seats: seatsFor(recipient, stage),
  pause: { isPaused: false, disconnectedSeats: [] },
  proposal: null,
  takeoverReservations: [],
})

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const parseFrozen = <S extends z.ZodType>(schema: S, value: unknown): Readonly<z.output<S>> =>
  deepFreeze(schema.parse(value))

export const PUBLIC_LOBBY_FIXTURE = parseFrozen(LobbySummarySchema, {
  roomId: IDS.room,
  roomCode: 'MJ2345',
  visibility: 'public',
  status: 'waiting',
  isPaused: false,
  humanCount: 3,
  availableSeatCount: 0,
  takeoverSeatCount: 1,
})

export const ROOM_ENTRY_FIXTURE = parseFrozen(RoomEntrySummarySchema, {
  roomCode: 'MJ2345',
  status: 'playing',
  isPaused: false,
  humanCount: 3,
  availableSeatCount: 0,
  takeoverSeats: [2],
  seats: [
    { seat: 0, kind: 'human', displayName: 'Ana', connection: 'connected' },
    { seat: 1, kind: 'human', displayName: 'Ben', connection: 'connected' },
    { seat: 2, kind: 'bot', takeoverAvailable: true },
    { seat: 3, kind: 'human', displayName: 'Cora', connection: 'connected' },
  ],
})

export const WAITING_ROOM_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...base(0, 'waiting'),
  stage: 'waiting',
})

export const ACTIVE_LOCAL_TURN_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...base(0, 'playing'),
  stage: 'playing',
  handId: IDS.hand,
  gameRevision: 20,
  wallRemainingCount: 71,
  phase: { phaseId: IDS.phaseAction, kind: 'player-action', actingSeat: 0 },
  privateState: {
    seat: 0,
    concealedTiles: [
      suited('sticks-1-a', 'sticks', 1),
      suited('sticks-2-a', 'sticks', 2),
      suited('sticks-3-a', 'sticks', 3),
    ],
    drawnTileId: 'sticks-3-a',
    legalChoices: [{ choiceId: IDS.choice, kind: 'discard', tileId: 'sticks-1-a' }],
    hasResponded: false,
  },
})

export const MASKED_SECRET_OWNER_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...base(1, 'playing'),
  stage: 'playing',
  handId: IDS.hand,
  gameRevision: 20,
  wallRemainingCount: 71,
  phase: { phaseId: IDS.phaseAction, kind: 'player-action', actingSeat: 0 },
  privateState: {
    seat: 1,
    concealedTiles: [suited('characters-1-a', 'characters', 1)],
    drawnTileId: null,
    legalChoices: [],
    hasResponded: false,
  },
})

export const PENDING_CLAIM_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...base(0, 'playing'),
  roomRevision: 9,
  stage: 'playing',
  handId: IDS.hand,
  gameRevision: 22,
  wallRemainingCount: 71,
  phase: {
    phaseId: IDS.phaseClaim,
    kind: 'discard-responses',
    discarderSeat: 3,
    latestDiscard: suited('characters-9-b', 'characters', 9),
    respondedSeats: [0, 2],
  },
  privateState: { seat: 0, concealedTiles: [], drawnTileId: null, legalChoices: [], hasResponded: true },
})

export const PAUSED_PROPOSAL_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...base(0, 'playing'),
  roomRevision: 10,
  stage: 'playing',
  handId: IDS.hand,
  gameRevision: 22,
  wallRemainingCount: 71,
  phase: {
    phaseId: IDS.phaseClaim,
    kind: 'discard-responses',
    discarderSeat: 3,
    latestDiscard: suited('characters-9-b', 'characters', 9),
    respondedSeats: [0],
  },
  privateState: { seat: 0, concealedTiles: [], drawnTileId: null, legalChoices: [], hasResponded: true },
  pause: { isPaused: true, disconnectedSeats: [3] },
  proposal: {
    proposalId: IDS.proposal,
    kind: 'replace-with-bot',
    proposedBy: 0,
    targetSeat: 3,
    votes: [
      { seat: 0, status: 'approved' },
      { seat: 1, status: 'pending' },
    ],
  },
})

export const DEFERRED_TAKEOVER_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...PENDING_CLAIM_FIXTURE,
  takeoverReservations: [{
    takeoverId: IDS.takeover,
    seat: 2,
    status: 'pending-phase-resolution',
    isMine: true,
  }],
})

const winningGroups = [
  { kind: 'pair', tiles: [suited('balls-1-a', 'balls', 1), suited('balls-1-b', 'balls', 1)] },
  { kind: 'chow', tiles: [suited('balls-2-a', 'balls', 2), suited('balls-3-a', 'balls', 3), suited('balls-4-a', 'balls', 4)] },
  { kind: 'pong', tiles: [suited('sticks-2-a', 'sticks', 2), suited('sticks-2-b', 'sticks', 2), suited('sticks-2-c', 'sticks', 2)] },
  { kind: 'chow', tiles: [suited('sticks-3-a', 'sticks', 3), suited('sticks-4-a', 'sticks', 4), suited('sticks-5-a', 'sticks', 5)] },
  { kind: 'chow', tiles: [suited('characters-3-a', 'characters', 3), suited('characters-4-a', 'characters', 4), suited('characters-5-a', 'characters', 5)] },
  { kind: 'pong', tiles: [suited('characters-7-a', 'characters', 7), suited('characters-7-b', 'characters', 7), suited('characters-7-c', 'characters', 7)] },
]

export const COMPLETED_HAND_FIXTURE = parseFrozen(RoomSnapshotSchema, {
  ...base(0, 'between-hands'),
  roomRevision: 11,
  stage: 'between-hands',
  handId: IDS.hand,
  gameRevision: 25,
  result: {
    kind: 'win',
    winnerSeat: 0,
    source: 'self-draw',
    winningTile: suited('characters-7-c', 'characters', 7),
    decomposition: { kind: 'regular', groups: winningGroups },
    nextDealerSeat: 0,
  },
})

export const ROOM_SNAPSHOT_FIXTURES = deepFreeze([
  WAITING_ROOM_FIXTURE,
  ACTIVE_LOCAL_TURN_FIXTURE,
  MASKED_SECRET_OWNER_FIXTURE,
  PENDING_CLAIM_FIXTURE,
  PAUSED_PROPOSAL_FIXTURE,
  DEFERRED_TAKEOVER_FIXTURE,
  COMPLETED_HAND_FIXTURE,
])
