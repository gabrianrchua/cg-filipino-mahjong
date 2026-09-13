import { describe, expect, it } from 'vitest'

import {
  ACTIVE_LOCAL_TURN_FIXTURE,
  ClientCommandSchema,
  CommandAcknowledgementSchema,
  CommandIdSchema,
  COMPLETED_HAND_FIXTURE,
  DEFERRED_TAKEOVER_FIXTURE,
  MASKED_SECRET_OWNER_FIXTURE,
  PAUSED_PROPOSAL_FIXTURE,
  PENDING_CLAIM_FIXTURE,
  PUBLIC_LOBBY_FIXTURE,
  ROOM_SNAPSHOT_FIXTURES,
  RoomSnapshotSchema,
  SocketAuthSchema,
  WAITING_ROOM_FIXTURE,
} from './index.js'

const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

const validCommands = [
  { commandId: id(100), type: 'session.bootstrap', displayName: '  Gabrian  ' },
  { commandId: id(101), type: 'lobby.list' },
  { commandId: id(102), type: 'room.create', visibility: 'public' },
  { commandId: id(103), type: 'room.join', roomCode: ' mj2345 ' },
  {
    commandId: id(104), type: 'room.set-visibility', roomId: id(1),
    expectedRoomRevision: 3, visibility: 'unlisted',
  },
  {
    commandId: id(105), type: 'room.configure-seat', roomId: id(1),
    expectedRoomRevision: 3, seat: 2, controller: 'bot',
  },
  {
    commandId: id(106), type: 'room.set-ready', roomId: id(1),
    readinessId: id(2), ready: true,
  },
  {
    commandId: id(107), type: 'game.action', roomId: id(1), handId: id(3), phaseId: id(4),
    action: { kind: 'discard', choiceId: id(5) },
  },
  {
    commandId: id(108), type: 'game.action', roomId: id(1), handId: id(3), phaseId: id(4),
    action: { kind: 'win', choiceId: id(6) },
  },
  {
    commandId: id(109), type: 'game.action', roomId: id(1), handId: id(3), phaseId: id(4),
    action: { kind: 'secret', choiceId: id(7) },
  },
  {
    commandId: id(110), type: 'game.action', roomId: id(1), handId: id(3), phaseId: id(4),
    action: { kind: 'sagasa', choiceId: id(8) },
  },
  {
    commandId: id(111), type: 'game.action', roomId: id(1), handId: id(3), phaseId: id(4),
    action: { kind: 'respond-to-discard', choiceId: id(9) },
  },
  {
    commandId: id(112), type: 'proposal.create', roomId: id(1),
    proposal: { kind: 'abort-hand' },
  },
  {
    commandId: id(113), type: 'proposal.create', roomId: id(1),
    proposal: { kind: 'replace-with-bot', targetSeat: 3 },
  },
  {
    commandId: id(114), type: 'proposal.vote', roomId: id(1), proposalId: id(10),
    vote: 'approve',
  },
  { commandId: id(115), type: 'room.leave', roomId: id(1) },
  { commandId: id(116), type: 'room.takeover', roomCode: 'MJ2345', seat: 2 },
] as const

const malformedCommands = [
  { ...validCommands[0], displayName: '' },
  { ...validCommands[1], unexpected: true },
  { ...validCommands[2], visibility: 'secret' },
  { ...validCommands[3], roomCode: 'O0I1AA' },
  { ...validCommands[4], expectedRoomRevision: -1 },
  { ...validCommands[5], seat: 4 },
  { ...validCommands[6], readinessId: 'old-readiness' },
  { ...validCommands[7], phaseId: 'old-phase' },
  { ...validCommands[12], proposal: { kind: 'replace-with-bot', targetSeat: 4 } },
  { ...validCommands[14], vote: 'maybe' },
  { ...validCommands[15], roomId: 'missing-room-id' },
  { ...validCommands[16], seat: 4 },
] as const

describe('client command contracts', () => {
  it.each(validCommands)('accepts $type', (command) => {
    expect(ClientCommandSchema.safeParse(command).success).toBe(true)
  })

  it.each(malformedCommands)('rejects malformed $type', (command) => {
    expect(ClientCommandSchema.safeParse(command).success).toBe(false)
  })

  it('normalizes bounded user input', () => {
    const bootstrap = ClientCommandSchema.parse(validCommands[0])
    const join = ClientCommandSchema.parse(validCommands[3])
    expect('displayName' in bootstrap && bootstrap.displayName).toBe('Gabrian')
    expect('roomCode' in join && join.roomCode).toBe('MJ2345')
  })

  it('rejects malformed, unbounded, and unknown command data', () => {
    expect(ClientCommandSchema.safeParse({ type: 'lobby.list' }).success).toBe(false)
    expect(ClientCommandSchema.safeParse({ ...validCommands[0], displayName: 'x'.repeat(25) }).success).toBe(false)
    expect(ClientCommandSchema.safeParse({ ...validCommands[0], displayName: 'bad\nname' }).success).toBe(false)
    expect(ClientCommandSchema.safeParse({ ...validCommands[3], roomCode: 'O0I1AA' }).success).toBe(false)
    expect(ClientCommandSchema.safeParse({ ...validCommands[1], surprise: true }).success).toBe(false)
    expect(CommandIdSchema.safeParse('not-a-uuid').success).toBe(false)
  })

  it('allows independent responses and votes without incidental revisions', () => {
    const firstResponse = validCommands[11]
    const secondResponse = { ...firstResponse, commandId: id(117), action: { ...firstResponse.action, choiceId: id(18) } }
    const firstVote = validCommands[14]
    const secondVote = { ...firstVote, commandId: id(118) }

    for (const command of [firstResponse, secondResponse, firstVote, secondVote]) {
      const parsed = ClientCommandSchema.parse(command)
      expect(parsed).not.toHaveProperty('expectedRoomRevision')
    }
    expect(secondResponse.phaseId).toBe(firstResponse.phaseId)
    expect(secondVote.proposalId).toBe(firstVote.proposalId)
  })
})

describe('acknowledgement contracts', () => {
  it('models accepted duplicate outcomes without reapplication data', () => {
    expect(CommandAcknowledgementSchema.parse({
      commandId: id(100), status: 'accepted', duplicate: true,
      result: { kind: 'completed' },
    }).duplicate).toBe(true)
  })

  it('models stable stale-hand errors with a safe resync snapshot', () => {
    expect(CommandAcknowledgementSchema.safeParse({
      commandId: id(100), status: 'rejected', duplicate: false,
      error: {
        code: 'stale-hand', message: 'The hand has changed.',
        details: { roomId: id(1), currentHandId: id(3), currentPhaseId: id(4) },
      },
      snapshot: ACTIVE_LOCAL_TURN_FIXTURE,
    }).success).toBe(true)
  })

  it('rejects arbitrary error details that could leak private state', () => {
    expect(CommandAcknowledgementSchema.safeParse({
      commandId: id(100), status: 'rejected', duplicate: false,
      error: { code: 'internal-error', message: 'Nope', details: { wall: ['secret'] } },
    }).success).toBe(false)
  })
})

describe('recipient-safe fixtures', () => {
  it('validates every representative fixture', () => {
    expect(PUBLIC_LOBBY_FIXTURE.roomCode).toBe('MJ2345')
    for (const fixture of ROOM_SNAPSHOT_FIXTURES) {
      expect(RoomSnapshotSchema.safeParse(fixture).success).toBe(true)
      expect(Object.isFrozen(fixture)).toBe(true)
    }
    expect([
      WAITING_ROOM_FIXTURE,
      PENDING_CLAIM_FIXTURE,
      PAUSED_PROPOSAL_FIXTURE,
      DEFERRED_TAKEOVER_FIXTURE,
      COMPLETED_HAND_FIXTURE,
    ]).toHaveLength(5)
  })

  it('reveals a secret only in its owner projection', () => {
    const observerSecret = ACTIVE_LOCAL_TURN_FIXTURE.seats[1]?.melds[0]
    const ownerSecret = MASKED_SECRET_OWNER_FIXTURE.seats[1]?.melds[0]
    expect(observerSecret).toMatchObject({ kind: 'secret', visibility: 'masked', tileCount: 4 })
    expect(observerSecret).not.toHaveProperty('tiles')
    expect(ownerSecret).toMatchObject({ kind: 'secret', visibility: 'owner' })
    expect(ownerSecret).toHaveProperty('tiles')
  })

  it('publishes response completion without response contents', () => {
    if (PENDING_CLAIM_FIXTURE.stage !== 'playing' || PENDING_CLAIM_FIXTURE.phase.kind !== 'discard-responses') {
      throw new Error('Invalid pending-claim fixture')
    }
    expect(PENDING_CLAIM_FIXTURE.phase.respondedSeats).toEqual([0, 2])
    expect(PENDING_CLAIM_FIXTURE.phase).not.toHaveProperty('responses')
    expect(PENDING_CLAIM_FIXTURE.phase).not.toHaveProperty('chosenTiles')
  })

  it('rejects hidden fields at every strict public boundary', () => {
    expect(RoomSnapshotSchema.safeParse({ ...ACTIVE_LOCAL_TURN_FIXTURE, wallOrder: [] }).success).toBe(false)
    expect(RoomSnapshotSchema.safeParse({ ...ACTIVE_LOCAL_TURN_FIXTURE, reconnectCredential: 'a'.repeat(43) }).success).toBe(false)
    expect(SocketAuthSchema.safeParse({ reconnectCredential: 'a'.repeat(43), roomId: id(1) }).success).toBe(false)
  })

  it('rejects recipient projections containing another seat\'s private state', () => {
    if (ACTIVE_LOCAL_TURN_FIXTURE.stage !== 'playing') throw new Error('Expected active fixture')
    expect(RoomSnapshotSchema.safeParse({
      ...ACTIVE_LOCAL_TURN_FIXTURE,
      privateState: { ...ACTIVE_LOCAL_TURN_FIXTURE.privateState, seat: 1 },
    }).success).toBe(false)

    const seats = ACTIVE_LOCAL_TURN_FIXTURE.seats.map((seat) => ({ ...seat, melds: [...seat.melds] }))
    seats[1] = { ...seats[1]!, melds: [
      {
        meldId: id(18), kind: 'secret', visibility: 'owner',
        tiles: [
          { tileId: 'leak-a', kind: 'suited', suit: 'sticks', rank: 8 },
          { tileId: 'leak-b', kind: 'suited', suit: 'sticks', rank: 8 },
          { tileId: 'leak-c', kind: 'suited', suit: 'sticks', rank: 8 },
          { tileId: 'leak-d', kind: 'suited', suit: 'sticks', rank: 8 },
        ],
      },
    ] }
    expect(RoomSnapshotSchema.safeParse({ ...ACTIVE_LOCAL_TURN_FIXTURE, seats }).success).toBe(false)
  })

  it('contains no credential, wall-order, or private-bot keys', () => {
    const serialized = JSON.stringify([PUBLIC_LOBBY_FIXTURE, ...ROOM_SNAPSHOT_FIXTURES])
    expect(serialized).not.toMatch(/reconnectCredential|wallOrder|privateBot|sessionCredential/u)
  })

  it('enforces exact tile counts for published decomposition groups', () => {
    if (COMPLETED_HAND_FIXTURE.stage !== 'between-hands' || COMPLETED_HAND_FIXTURE.result.kind !== 'win') {
      throw new Error('Expected completed winning hand fixture')
    }
    const groups = COMPLETED_HAND_FIXTURE.result.decomposition.groups.map((group) => ({
      ...group,
      tiles: [...group.tiles],
    }))
    groups[0] = { ...groups[0]!, tiles: groups[0]!.tiles.slice(0, 1) }

    expect(RoomSnapshotSchema.safeParse({
      ...COMPLETED_HAND_FIXTURE,
      result: {
        ...COMPLETED_HAND_FIXTURE.result,
        decomposition: { ...COMPLETED_HAND_FIXTURE.result.decomposition, groups },
      },
    }).success).toBe(false)
  })
})
