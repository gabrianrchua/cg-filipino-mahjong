import { describe, expect, it } from 'vitest'
import { RoomSnapshotSchema } from '@cg-filipino-mahjong/shared'

import {
  abortHand,
  createCanonicalTileSet,
  initializeHand,
} from '../game-engine/index.js'
import {
  RoomService,
  type RoomServiceOptions,
  type RoomServiceResult,
  type SessionBootstrap,
} from './index.js'

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const id = (suffix: number) => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

function codeFor(value: number): string {
  let remaining = value
  let code = ''
  for (let index = 0; index < 6; index += 1) {
    code = CODE_ALPHABET[remaining & 31]! + code
    remaining >>>= 5
  }
  return code
}

function fixtureOptions(overrides: RoomServiceOptions = {}): RoomServiceOptions {
  let id = 1
  let credential = 1
  let roomCode = 1
  return {
    createId: () => `00000000-0000-4000-8000-${(id++).toString().padStart(12, '0')}`,
    createCredential: () => `credential_${(credential++).toString().padStart(40, '0')}`,
    createRoomCode: () => codeFor(roomCode++),
    ...overrides,
  }
}

function unwrap<T>(result: RoomServiceResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

function expectError<T>(result: RoomServiceResult<T>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

function bootstrap(service: RoomService, name: string, controllerId: string): SessionBootstrap {
  return unwrap(service.bootstrapSession(name, controllerId))
}

describe('guest sessions', () => {
  it('issues bounded secret credentials and normalizes display names', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, '  Ana  ', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')

    expect(ana.session.displayName).toBe('Ana')
    expect(ana.reconnectCredential).not.toBe(ben.reconnectCredential)
    expect(ana.reconnectCredential).not.toContain('Ana')
    expect(JSON.stringify(ana.session)).not.toContain(ana.reconnectCredential)
    expectError(service.bootstrapSession('x'.repeat(25), 'socket-c'), 'validation-error')
    expectError(service.bootstrapSession('Other', 'socket-a'), 'invalid-controller')
  })

  it('bounds anonymous session allocation', () => {
    const service = new RoomService(fixtureOptions({ maxSessions: 1 }))
    bootstrap(service, 'Ana', 'socket-a')
    expectError(service.bootstrapSession('Ben', 'socket-b'), 'rate-limited')
  })

  it('supersedes older controllers without allowing stale actions or disconnects', () => {
    const service = new RoomService(fixtureOptions())
    const initial = bootstrap(service, 'Ana', 'socket-old')
    const resumed = unwrap(service.authenticate(initial.reconnectCredential, 'socket-new'))

    expect(resumed.supersededControllerId).toBe('socket-old')
    expectError(service.listPublicRooms(initial.control), 'session-superseded')
    expect(unwrap(service.disconnect(initial.control)).disconnected).toBe(false)
    expect(unwrap(service.listPublicRooms(resumed.control)).rooms).toEqual([])
    expectError(service.authenticate('not-a-real-credential', 'socket-other'), 'invalid-session')
  })
})

describe('room discovery and seating', () => {
  it('lists only public summaries while allowing normalized entry to unlisted rooms', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const room = unwrap(service.createRoom(ana.control, 'unlisted'))

    expect(unwrap(service.listPublicRooms(ben.control)).rooms).toEqual([])
    expect(unwrap(service.inspectRoom(ben.control, `  ${room.roomCode.toLowerCase()}  `))).toEqual({
      roomCode: room.roomCode,
      status: 'waiting',
      isPaused: false,
      humanCount: 1,
      availableSeatCount: 3,
      spectatorCount: 0,
      takeoverSeats: [],
      seats: [
        { seat: 0, kind: 'human', displayName: 'Ana', connection: 'connected' },
        { seat: 1, kind: 'available' },
        { seat: 2, kind: 'available' },
        { seat: 3, kind: 'available' },
      ],
    })
    const joined = unwrap(service.joinRoom(ben.control, `  ${room.roomCode.toLowerCase()}  `))
    expect(joined.seats[1].controller).toMatchObject({ kind: 'human', displayName: 'Ben' })

    const cora = bootstrap(service, 'Cora', 'socket-c')
    expect(unwrap(service.inspectRoom(cora.control, room.roomCode)).seats[1]).toEqual({
      seat: 1, kind: 'human', displayName: 'Ben', connection: 'connected',
    })

    const publicRoom = unwrap(service.setVisibility(
      ben.control,
      room.roomId,
      joined.roomRevision,
      'public',
    ))
    expect(unwrap(service.listPublicRooms(ana.control)).rooms).toEqual([{
      roomId: room.roomId,
      roomCode: room.roomCode,
      visibility: 'public',
      status: 'waiting',
      isPaused: false,
      humanCount: 2,
      availableSeatCount: 2,
      takeoverSeatCount: 0,
      spectatorCount: 0,
    }])
    expect(publicRoom.visibility).toBe('public')
    expectError(service.inspectRoom(ben.control, room.roomCode), 'already-seated')
  })

  it('checks code collisions, capacity, invalid codes, and one-room ownership', () => {
    const codes = ['ABC234', 'ABC234', 'DEF567']
    const service = new RoomService(fixtureOptions({ createRoomCode: () => codes.shift() ?? 'GHJ789' }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const cora = bootstrap(service, 'Cora', 'socket-c')
    const first = unwrap(service.createRoom(ana.control, 'public'))
    const second = unwrap(service.createRoom(ben.control, 'public'))

    expect(first.roomCode).toBe('ABC234')
    expect(second.roomCode).toBe('DEF567')
    expectError(service.createRoom(ana.control, 'public'), 'already-seated')
    expectError(service.joinRoom(cora.control, 'O0I1AA'), 'room-not-found')

    let full = first
    for (const seat of [1, 2, 3] as const) {
      full = unwrap(service.configureSeat(ana.control, full.roomId, full.roomRevision, seat, 'bot'))
    }
    expectError(service.joinRoom(cora.control, first.roomCode), 'room-full')
    expect(unwrap(service.inspectRoom(cora.control, first.roomCode)).takeoverSeats).toEqual([1, 2, 3])
  })

  it('rejects room creation when collision retries are exhausted', () => {
    const service = new RoomService(fixtureOptions({
      createRoomCode: () => 'ABC234',
      maxCodeAttempts: 2,
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    unwrap(service.createRoom(ana.control, 'public'))

    expectError(service.createRoom(ben.control, 'public'), 'internal-error')
  })

  it('bounds active rooms and reports expired codes distinctly', () => {
    const service = new RoomService(fixtureOptions({ maxRooms: 1 }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const room = unwrap(service.createRoom(ana.control, 'public'))

    expectError(service.createRoom(ben.control, 'public'), 'rate-limited')
    unwrap(service.expireRoom(room.roomId))
    expectError(service.joinRoom(ben.control, room.roomCode), 'room-expired')
    expectError(service.inspectRoom(ben.control, room.roomCode), 'room-expired')
    expectError(service.inspectRoom(ben.control, 'ZZZZZZ'), 'room-not-found')
    expectError(service.joinRoom(ben.control, 'ZZZZZZ'), 'room-not-found')
  })

  it('commits only one winner when guests compete for the last available seat', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const cora = bootstrap(service, 'Cora', 'socket-c')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 2, 'bot'))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 3, 'bot'))

    const firstJoin = service.joinRoom(ben.control, room.roomCode)
    const competingJoin = service.joinRoom(cora.control, room.roomCode)
    expect(unwrap(firstJoin).seats.filter((seat) => seat.controller.kind === 'human')).toHaveLength(2)
    expectError(competingJoin, 'room-full')
  })
})

describe('hostless configuration and readiness', () => {
  it('gives every human equal configuration authority and clears readiness on roster changes', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const created = unwrap(service.createRoom(ana.control, 'public'))
    const anaReady = unwrap(service.setReady(ana.control, created.roomId, created.readinessId, true))
    expect(anaReady.seats[0].controller).toMatchObject({ kind: 'human', ready: true })

    const joined = unwrap(service.joinRoom(ben.control, created.roomCode))
    expect(joined.readinessId).not.toBe(anaReady.readinessId)
    expect(joined.seats[0].controller).toMatchObject({ kind: 'human', ready: false })
    expectError(service.configureSeat(ana.control, joined.roomId, created.roomRevision, 2, 'bot'), 'stale-room')

    const configured = unwrap(service.configureSeat(
      ben.control,
      joined.roomId,
      joined.roomRevision,
      2,
      'bot',
    ))
    expect(configured.seats[2].controller.kind).toBe('bot')
    expectError(service.configureSeat(ben.control, configured.roomId, configured.roomRevision, 0, 'bot'), 'seat-unavailable')
  })

  it('starts only with a full roster of connected, ready humans and automatic bots', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.joinRoom(ben.control, room.roomCode))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 2, 'bot'))
    room = unwrap(service.configureSeat(ben.control, room.roomId, room.roomRevision, 3, 'bot'))
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))

    const disconnected = unwrap(service.disconnect(ana.control))
    expect(disconnected.room?.seats[0].controller).toMatchObject({ kind: 'human', connected: false, ready: true })
    room = unwrap(service.setReady(ben.control, room.roomId, room.readinessId, true))
    expect(room.stage.kind).toBe('waiting')

    const returned = unwrap(service.authenticate(ana.reconnectCredential, 'socket-a-returned'))
    expect(returned.room?.stage.kind).toBe('playing')
    expect(returned.room?.stage.kind === 'playing' && returned.room.stage.engineState.phase.kind).not.toBe('setup')
  })

  it('supports the one-human and four-human readiness boundaries', () => {
    const soloService = new RoomService(fixtureOptions())
    const solo = bootstrap(soloService, 'Solo', 'socket-solo')
    let soloRoom = unwrap(soloService.createRoom(solo.control, 'public'))
    for (const seat of [1, 2, 3] as const) {
      soloRoom = unwrap(soloService.configureSeat(
        solo.control,
        soloRoom.roomId,
        soloRoom.roomRevision,
        seat,
        'bot',
      ))
    }
    soloRoom = unwrap(soloService.setReady(solo.control, soloRoom.roomId, soloRoom.readinessId, true))
    expect(soloRoom.stage.kind).toBe('playing')

    const fullService = new RoomService(fixtureOptions())
    const humans = ['Ana', 'Ben', 'Cora', 'Dan'].map((name, index) => (
      bootstrap(fullService, name, `socket-${index}`)
    ))
    let fullRoom = unwrap(fullService.createRoom(humans[0]!.control, 'unlisted'))
    for (const human of humans.slice(1)) {
      fullRoom = unwrap(fullService.joinRoom(human.control, fullRoom.roomCode))
    }
    for (const human of humans) {
      fullRoom = unwrap(fullService.setReady(human.control, fullRoom.roomId, fullRoom.readinessId, true))
    }
    expect(fullRoom.stage.kind).toBe('playing')
  })

  it('vacates pre-hand leaves but reserves disconnects until return or approved replacement', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.joinRoom(ben.control, room.roomCode))

    const disconnected = unwrap(service.disconnect(ben.control)).room!
    expect(disconnected.seats[1].controller).toMatchObject({ kind: 'human', connected: false })
    const replacement = service.commitApprovedBotReplacement(room.roomId, 1)
    expect(replacement.ok && replacement.detachedSessionIds).toEqual([ben.session.sessionId])
    const replaced = unwrap(replacement)
    expect(replaced.seats[1].controller.kind).toBe('bot')
    expectError(service.createRoom(ben.control, 'public'), 'invalid-controller')

    const returned = unwrap(service.authenticate(ben.reconnectCredential, 'socket-b-returned'))
    const joinedAgain = unwrap(service.joinRoom(returned.control, room.roomCode))
    const left = unwrap(service.leaveRoom(returned.control, room.roomId))
    expect(left.seats[joinedAgain.seats.findIndex((seat) => (
      seat.controller.kind === 'human' && seat.controller.displayName === 'Ben'
    ))]!.controller.kind).toBe('available')
    expect(unwrap(service.createRoom(returned.control, 'unlisted')).visibility).toBe('unlisted')
  })

  it('replaces multiple disconnected waiting-room humans one at a time with one voter', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const cora = bootstrap(service, 'Cora', 'socket-c')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.joinRoom(ben.control, room.roomCode))
    room = unwrap(service.joinRoom(cora.control, room.roomCode))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 3, 'bot'))
    unwrap(service.disconnect(ben.control))
    room = unwrap(service.disconnect(cora.control)).room!

    const benReplacement = service.createProposal(ana.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 1 },
    })
    expect(benReplacement.ok && benReplacement.detachedSessionIds).toEqual([ben.session.sessionId])
    room = unwrap(benReplacement)
    expect(room.seats[1].controller.kind).toBe('bot')
    expect(room.proposal).toBeNull()
    expect(room.seats[2].controller).toMatchObject({ kind: 'human', connected: false })
    expect(unwrap(service.getRecipientSnapshot(ana.control, room.roomId)).pause).toEqual({
      isPaused: true,
      disconnectedSeats: [2],
    })

    const coraReplacement = service.createProposal(ana.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 2 },
    })
    expect(coraReplacement.ok && coraReplacement.detachedSessionIds).toEqual([cora.session.sessionId])
    room = unwrap(coraReplacement)
    expect(room.seats[2].controller.kind).toBe('bot')
    expect(unwrap(service.getRecipientSnapshot(ana.control, room.roomId)).pause.isPaused).toBe(false)
    expect(unwrap(service.authenticate(ben.reconnectCredential, 'socket-b-returned')).room).toBeNull()
  })

  it('cancels waiting-room proposals whenever the connected-human roster changes', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const cora = bootstrap(service, 'Cora', 'socket-c')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.joinRoom(ben.control, room.roomCode))
    room = unwrap(service.joinRoom(cora.control, room.roomCode))
    unwrap(service.disconnect(cora.control))
    room = unwrap(service.createProposal(ana.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 2 },
    }))
    expect(room.proposal?.votes).toEqual([
      { seat: 0, status: 'approved' },
      { seat: 1, status: 'pending' },
    ])

    room = unwrap(service.disconnect(ben.control)).room!
    expect(room.proposal).toBeNull()
    const returnedBen = unwrap(service.authenticate(ben.reconnectCredential, 'socket-b-returned'))
    expect(returnedBen.room?.proposal).toBeNull()

    room = unwrap(service.createProposal(returnedBen.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 2 },
    }))
    expect(room.proposal).not.toBeNull()
    const returnedCora = unwrap(service.authenticate(cora.reconnectCredential, 'socket-c-returned'))
    expect(returnedCora.room?.proposal).toBeNull()
    expectError(service.createProposal(ana.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 2 },
    }), 'invalid-room-state')
  })
})

describe('bot-seat takeover', () => {
  function botRoom(dealerSeat: 0 | 1 = 0) {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat, randomSource: { nextInt: () => 0 } }),
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    for (const seat of [1, 2, 3] as const) {
      room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, seat, 'bot'))
    }
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')
    return { service, ana, room }
  }

  function discardAsAna(
    service: RoomService,
    ana: SessionBootstrap,
    room: ReturnType<typeof botRoom>['room'],
  ) {
    const choices = unwrap(service.getLegalChoices(ana.control, room.roomId))
    const discard = choices.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected a discard')
    const changed = unwrap(service.applyGameAction(ana.control, {
      roomId: room.roomId,
      handId: choices.handId,
      phaseId: choices.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }))
    if (changed.stage.kind !== 'playing' || changed.stage.engineState.phase.kind !== 'discard-responses') {
      throw new Error('Expected discard responses')
    }
    return changed
  }

  function passAsBot(service: RoomService, roomId: string, seat: 1 | 2 | 3) {
    const snapshot = unwrap(service.getBotDecisionSnapshot(roomId, seat))
    if (snapshot.stage !== 'playing') throw new Error('Expected bot play')
    const pass = snapshot.privateState?.legalChoices.find((choice) => choice.kind === 'pass')
    if (!pass) throw new Error('Expected a pass')
    return unwrap(service.applyBotGameAction({
      roomId: snapshot.roomId,
      seat,
      handId: snapshot.handId,
      phaseId: snapshot.phase.phaseId,
      choiceId: pass.choiceId,
    }))
  }

  it('commits immediately between actions without changing game state', () => {
    const { service, ana, room } = botRoom()
    const ben = bootstrap(service, 'Ben', 'socket-b')
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')
    const engineState = room.stage.engineState
    const phaseId = room.stage.phaseId
    const takeover = unwrap(service.requestBotSeatTakeover(ben.control, room.roomCode, 1))

    expect(takeover.kind).toBe('committed')
    expect(takeover.room.seats[1].controller).toMatchObject({
      kind: 'human', displayName: 'Ben', connected: true,
    })
    expect(takeover.room.stage.kind === 'playing' && takeover.room.stage.engineState).toBe(engineState)
    expect(takeover.room.stage.kind === 'playing' && takeover.room.stage.phaseId).toBe(phaseId)
    expect(unwrap(service.getRecipientSnapshot(ben.control, room.roomId)).self)
      .toEqual({ role: 'player', seat: 1, canControl: true })
    expectError(service.requestBotSeatTakeover(ana.control, room.roomCode, 2), 'already-seated')
  })

  it('defers through the whole response phase, keeps bots active, and commits distinct seats together', () => {
    const started = botRoom()
    const ben = bootstrap(started.service, 'Ben', 'socket-b')
    const cora = bootstrap(started.service, 'Cora', 'socket-c')
    const dan = bootstrap(started.service, 'Dan', 'socket-d')
    let room = discardAsAna(started.service, started.ana, started.room)
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')
    const engineStateAtReservation = room.stage.engineState

    const benTakeover = unwrap(started.service.requestBotSeatTakeover(ben.control, room.roomCode, 1))
    const coraTakeover = unwrap(started.service.requestBotSeatTakeover(cora.control, room.roomCode, 2))
    expect(benTakeover.kind).toBe('pending')
    expect(coraTakeover.kind).toBe('pending')
    expectError(started.service.requestBotSeatTakeover(dan.control, room.roomCode, 1), 'takeover-pending')
    expect(benTakeover.room.stage.kind === 'playing' && benTakeover.room.stage.engineState)
      .toBe(engineStateAtReservation)
    expect(benTakeover.room.seats[1].controller.kind).toBe('bot')
    expect(unwrap(started.service.listPublicRooms(dan.control)).rooms[0]?.takeoverSeatCount).toBe(1)
    const entry = unwrap(started.service.inspectRoom(dan.control, room.roomCode))
    expect(entry.takeoverSeats).toEqual([3])
    expect(entry.seats[1]).toEqual({ seat: 1, kind: 'bot', takeoverAvailable: false })
    expect(entry.seats[2]).toEqual({ seat: 2, kind: 'bot', takeoverAvailable: false })
    expect(entry.seats[3]).toEqual({ seat: 3, kind: 'bot', takeoverAvailable: true })
    expect(JSON.stringify(entry)).not.toMatch(/sessionId|takeoverId|privateState|concealedTiles/u)

    const benPending = unwrap(started.service.getRecipientSnapshot(ben.control, room.roomId))
    if (benPending.stage !== 'playing') throw new Error('Expected pending active snapshot')
    expect(benPending.self).toEqual({ role: 'pending-takeover', seat: null, canControl: false })
    expect(benPending.privateState).toBeNull()
    expect(benPending.takeoverReservations).toEqual([
      expect.objectContaining({ seat: 1, isMine: true }),
      expect.objectContaining({ seat: 2, isMine: false }),
    ])
    const payload = JSON.stringify(benPending)
    for (const seat of engineStateAtReservation.seats) {
      for (const tile of seat.concealedTiles) expect(payload).not.toContain(tile.tileId)
    }

    room = passAsBot(started.service, room.roomId, 1)
    expect(room.seats[1].controller.kind).toBe('bot')
    room = passAsBot(started.service, room.roomId, 2)
    expect(room.seats[2].controller.kind).toBe('bot')
    room = passAsBot(started.service, room.roomId, 3)
    expect(room.takeoverReservations).toEqual([])
    expect(room.seats[1].controller).toMatchObject({ kind: 'human', displayName: 'Ben' })
    expect(room.seats[2].controller).toMatchObject({ kind: 'human', displayName: 'Cora' })
    const committed = unwrap(started.service.getRecipientSnapshot(ben.control, room.roomId))
    expect(committed.self).toEqual({ role: 'player', seat: 1, canControl: true })
    expect(committed.stage === 'playing' && committed.privateState?.seat).toBe(1)
  })

  it('cancels pending reservations when the requester disconnects or leaves', () => {
    const started = botRoom()
    const ben = bootstrap(started.service, 'Ben', 'socket-b')
    const cora = bootstrap(started.service, 'Cora', 'socket-c')
    const room = discardAsAna(started.service, started.ana, started.room)

    unwrap(started.service.requestBotSeatTakeover(ben.control, room.roomCode, 1))
    const disconnected = unwrap(started.service.disconnect(ben.control))
    expect(disconnected.room?.takeoverReservations).toEqual([])

    unwrap(started.service.requestBotSeatTakeover(cora.control, room.roomCode, 1))
    const left = unwrap(started.service.leaveRoom(cora.control, room.roomId))
    expect(left.takeoverReservations).toEqual([])
    expect(unwrap(started.service.getControlledRoom(cora.control))).toBeNull()
  })

  it('gives a replaced player no preference over the current controller', () => {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } }),
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    const cora = bootstrap(service, 'Cora', 'socket-c')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.joinRoom(ben.control, room.roomCode))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 2, 'bot'))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 3, 'bot'))
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    room = unwrap(service.setReady(ben.control, room.roomId, room.readinessId, true))
    unwrap(service.disconnect(ben.control))
    room = unwrap(service.createProposal(ana.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 1 },
    }))
    expect(room.seats[1].controller.kind).toBe('bot')
    unwrap(service.requestBotSeatTakeover(cora.control, room.roomCode, 1))

    const returnedBen = unwrap(service.authenticate(ben.reconnectCredential, 'socket-b-returned'))
    expectError(service.requestBotSeatTakeover(returnedBen.control, room.roomCode, 1), 'seat-unavailable')
    const alternate = unwrap(service.requestBotSeatTakeover(returnedBen.control, room.roomCode, 2))
    expect(alternate.room.seats[2].controller).toMatchObject({ kind: 'human', displayName: 'Ben' })
  })

  it('updates voters only on commit and does not run a pending claim through a pause', () => {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } }),
    }))
    const humans = ['Ana', 'Ben', 'Cora'].map((name, index) => (
      bootstrap(service, name, `socket-${index}`)
    ))
    const dan = bootstrap(service, 'Dan', 'socket-d')
    let room = unwrap(service.createRoom(humans[0]!.control, 'public'))
    room = unwrap(service.joinRoom(humans[1]!.control, room.roomCode))
    room = unwrap(service.joinRoom(humans[2]!.control, room.roomCode))
    room = unwrap(service.configureSeat(humans[0]!.control, room.roomId, room.roomRevision, 3, 'bot'))
    for (const human of humans) {
      room = unwrap(service.setReady(human.control, room.roomId, room.readinessId, true))
    }
    const choices = unwrap(service.getLegalChoices(humans[0]!.control, room.roomId))
    const discard = choices.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected discard')
    room = unwrap(service.applyGameAction(humans[0]!.control, {
      roomId: room.roomId,
      handId: choices.handId,
      phaseId: choices.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }))
    room = unwrap(service.disconnect(humans[2]!.control)).room!
    room = unwrap(service.createProposal(humans[0]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'abort-hand' },
    }))
    const proposalId = room.proposal?.proposalId
    if (!proposalId) throw new Error('Expected active proposal')

    const pending = unwrap(service.requestBotSeatTakeover(dan.control, room.roomCode, 3))
    expect(pending.kind).toBe('pending')
    expect(pending.room.proposal?.proposalId).toBe(proposalId)
    const bot = unwrap(service.getBotDecisionSnapshot(room.roomId, 3))
    if (bot.stage !== 'playing') throw new Error('Expected bot response')
    const pass = bot.privateState?.legalChoices.find((choice) => choice.kind === 'pass')
    if (!pass) throw new Error('Expected bot pass')
    expectError(service.applyBotGameAction({
      roomId: room.roomId,
      seat: 3,
      handId: bot.handId,
      phaseId: bot.phase.phaseId,
      choiceId: pass.choiceId,
    }), 'room-paused')
    expect(unwrap(service.getRoom(humans[0]!.control, room.roomId)).takeoverReservations).toHaveLength(1)

    room = unwrap(service.voteOnProposal(humans[1]!.control, {
      roomId: room.roomId,
      proposalId,
      vote: 'approve',
    }))
    expect(room.stage.kind).toBe('between-hands')
    expect(room.takeoverReservations).toEqual([])
    expect(room.seats[3].controller).toMatchObject({ kind: 'human', displayName: 'Dan', ready: false })
  })
})

describe('authoritative game command handling', () => {
  function playingRoom() {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } }),
    }))
    const humans = ['Ana', 'Ben', 'Cora', 'Dan'].map((name, index) => (
      bootstrap(service, name, `socket-${index}`)
    ))
    let room = unwrap(service.createRoom(humans[0]!.control, 'public'))
    for (const human of humans.slice(1)) room = unwrap(service.joinRoom(human.control, room.roomCode))
    for (const human of humans) {
      room = unwrap(service.setReady(human.control, room.roomId, room.readinessId, true))
    }
    if (room.stage.kind !== 'playing') throw new Error('Expected a playing room')
    return { service, humans, room }
  }

  it('maps opaque choices to the authenticated seat and retains a response phase for independent claims', () => {
    const { service, humans, room } = playingRoom()
    const dealerChoices = unwrap(service.getLegalChoices(humans[0]!.control, room.roomId))
    const discard = dealerChoices.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected a discard choice')
    let changed = unwrap(service.applyGameAction(humans[0]!.control, {
      roomId: room.roomId,
      handId: dealerChoices.handId,
      phaseId: dealerChoices.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }))
    if (changed.stage.kind !== 'playing') throw new Error('Expected discard responses')
    const responsePhaseId = changed.stage.phaseId
    const startingRevision = changed.stage.gameRevision

    for (const human of humans.slice(1, 3)) {
      const choices = unwrap(service.getLegalChoices(human.control, room.roomId))
      const pass = choices.choices.find((choice) => choice.kind === 'pass')
      if (!pass) throw new Error('Expected a pass choice')
      changed = unwrap(service.applyGameAction(human.control, {
        roomId: room.roomId,
        handId: choices.handId,
        phaseId: choices.phaseId,
        action: { kind: 'respond-to-discard', choiceId: pass.choiceId },
      }))
      expect(changed.stage.kind === 'playing' && changed.stage.phaseId).toBe(responsePhaseId)
    }
    expect(changed.stage.kind === 'playing' && changed.stage.gameRevision).toBe(startingRevision + 2)

    const finalChoices = unwrap(service.getLegalChoices(humans[3]!.control, room.roomId))
    const finalPass = finalChoices.choices.find((choice) => choice.kind === 'pass')
    if (!finalPass) throw new Error('Expected a pass choice')
    changed = unwrap(service.applyGameAction(humans[3]!.control, {
      roomId: room.roomId,
      handId: finalChoices.handId,
      phaseId: finalChoices.phaseId,
      action: { kind: 'respond-to-discard', choiceId: finalPass.choiceId },
    }))
    expect(changed.stage.kind === 'playing' && changed.stage.phaseId).not.toBe(responsePhaseId)
  })

  it('rotates phase choices across disconnect and reconnect to reject buffered moves', () => {
    const { service, humans, room } = playingRoom()
    const before = unwrap(service.getLegalChoices(humans[0]!.control, room.roomId))
    const discard = before.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected a discard choice')

    unwrap(service.disconnect(humans[1]!.control))
    const resumed = unwrap(service.authenticate(humans[1]!.reconnectCredential, 'socket-returned'))
    expect(resumed.room?.stage.kind === 'playing' && resumed.room.stage.phaseId).not.toBe(before.phaseId)
    expectError(service.applyGameAction(humans[0]!.control, {
      roomId: room.roomId,
      handId: before.handId,
      phaseId: before.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }), 'stale-phase')
  })

  it('applies bot choices through the authoritative path with controller, pause, and freshness guards', () => {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 1, randomSource: { nextInt: () => 0 } }),
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    for (const seat of [1, 2, 3] as const) {
      room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, seat, 'bot'))
    }
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'playing') throw new Error('Expected active bot play')

    const initial = unwrap(service.getBotDecisionSnapshot(room.roomId, 1))
    if (initial.stage !== 'playing') throw new Error('Expected a bot decision snapshot')
    const discard = initial.privateState?.legalChoices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected a bot discard')
    const input = {
      roomId: room.roomId,
      seat: 1 as const,
      handId: initial.handId,
      phaseId: initial.phase.phaseId,
      choiceId: discard.choiceId,
    }

    expectError(service.applyBotGameAction({ ...input, seat: 0 }), 'invalid-controller')
    expectError(service.applyBotGameAction({ ...input, phaseId: id(999) }), 'stale-phase')
    unwrap(service.disconnect(ana.control))
    expectError(service.applyBotGameAction(input), 'room-paused')

    const resumed = unwrap(service.authenticate(ana.reconnectCredential, 'socket-returned'))
    const fresh = unwrap(service.getBotDecisionSnapshot(room.roomId, 1))
    if (fresh.stage !== 'playing') throw new Error('Expected resumed bot play')
    const freshDiscard = fresh.privateState?.legalChoices.find((choice) => choice.kind === 'discard')
    if (!freshDiscard) throw new Error('Expected a fresh bot discard')
    const changed = unwrap(service.applyBotGameAction({
      roomId: room.roomId,
      seat: 1,
      handId: fresh.handId,
      phaseId: fresh.phase.phaseId,
      choiceId: freshDiscard.choiceId,
    }))
    expect(resumed.room?.roomRevision).toBeLessThan(changed.roomRevision)
    expect(changed.stage.kind === 'playing' && changed.stage.engineState.phase.kind).toBe('discard-responses')
    expectError(service.applyBotGameAction(input), 'stale-phase')
  })

  it('retains submitted claims while paused and commits a unanimous abort through hand results', () => {
    const { service, humans, room } = playingRoom()
    const dealerChoices = unwrap(service.getLegalChoices(humans[0]!.control, room.roomId))
    const discard = dealerChoices.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected a discard choice')
    let changed = unwrap(service.applyGameAction(humans[0]!.control, {
      roomId: room.roomId,
      handId: dealerChoices.handId,
      phaseId: dealerChoices.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }))
    const response = unwrap(service.getLegalChoices(humans[1]!.control, room.roomId))
    const pass = response.choices.find((choice) => choice.kind === 'pass')
    if (!pass) throw new Error('Expected a pass choice')
    changed = unwrap(service.applyGameAction(humans[1]!.control, {
      roomId: room.roomId,
      handId: response.handId,
      phaseId: response.phaseId,
      action: { kind: 'respond-to-discard', choiceId: pass.choiceId },
    }))
    if (changed.stage.kind !== 'playing' || changed.stage.engineState.phase.kind !== 'discard-responses') {
      throw new Error('Expected pending responses')
    }
    const retainedResponses = changed.stage.engineState.phase.responses
    changed = unwrap(service.disconnect(humans[2]!.control)).room!
    expect(changed.stage.kind === 'playing' && changed.stage.engineState.phase.kind === 'discard-responses'
      ? changed.stage.engineState.phase.responses
      : []).toEqual(retainedResponses)

    changed = unwrap(service.createProposal(humans[0]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'abort-hand' },
    }))
    const proposalId = changed.proposal?.proposalId
    if (!proposalId) throw new Error('Expected an active proposal')
    expect(changed.proposal?.votes).toEqual([
      { seat: 0, status: 'approved' },
      { seat: 1, status: 'pending' },
      { seat: 3, status: 'pending' },
    ])
    expectError(service.createProposal(humans[1]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'abort-hand' },
    }), 'proposal-active')
    changed = unwrap(service.voteOnProposal(humans[1]!.control, {
      roomId: room.roomId,
      proposalId,
      vote: 'approve',
    }))
    const repeated = unwrap(service.voteOnProposal(humans[1]!.control, {
      roomId: room.roomId,
      proposalId,
      vote: 'approve',
    }))
    expect(repeated.roomRevision).toBe(changed.roomRevision)
    changed = unwrap(service.voteOnProposal(humans[3]!.control, {
      roomId: room.roomId,
      proposalId,
      vote: 'approve',
    }))
    expect(changed.proposal).toBeNull()
    expect(changed.stage.kind).toBe('between-hands')
    if (changed.stage.kind !== 'between-hands') throw new Error('Expected an aborted hand')
    expect(changed.stage.engineState.phase).toEqual({
      kind: 'ended',
      result: { kind: 'abort', nextDealerSeat: 0 },
    })
    expect(changed.seats.filter((seat) => seat.controller.kind === 'human')
      .every((seat) => seat.controller.kind === 'human' && !seat.controller.ready)).toBe(true)
  })

  it('cancels an active proposal on rejection or reconnect and rejects ineligible proposals', () => {
    const { service, humans, room } = playingRoom()
    unwrap(service.disconnect(humans[3]!.control))
    let changed = unwrap(service.createProposal(humans[0]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 3 },
    }))
    const rejectedId = changed.proposal?.proposalId
    if (!rejectedId) throw new Error('Expected a proposal')
    changed = unwrap(service.voteOnProposal(humans[1]!.control, {
      roomId: room.roomId,
      proposalId: rejectedId,
      vote: 'reject',
    }))
    expect(changed.proposal).toBeNull()
    expectError(service.voteOnProposal(humans[2]!.control, {
      roomId: room.roomId,
      proposalId: rejectedId,
      vote: 'approve',
    }), 'proposal-not-found')

    changed = unwrap(service.createProposal(humans[0]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 3 },
    }))
    expect(changed.proposal).not.toBeNull()
    const returned = unwrap(service.authenticate(humans[3]!.reconnectCredential, 'socket-returned'))
    expect(returned.room?.proposal).toBeNull()
    expectError(service.createProposal(humans[0]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'abort-hand' },
    }), 'invalid-room-state')
  })

  it('treats explicit mid-hand leave as a reserved disconnect and lets zero humans decide nothing', () => {
    const { service, humans, room } = playingRoom()
    const before = room.stage.kind === 'playing' ? room.stage.engineState : null
    const left = unwrap(service.leaveRoom(humans[1]!.control, room.roomId))
    expect(left.stage.kind).toBe('playing')
    expect(left.stage.kind === 'playing' ? left.stage.engineState : null).toBe(before)
    expect(left.seats[1].controller).toMatchObject({ kind: 'human', connected: false })
    expect(unwrap(service.getControlledRoom(humans[1]!.control))?.roomId).toBe(room.roomId)

    for (const human of [humans[0]!, humans[2]!, humans[3]!]) {
      unwrap(service.leaveRoom(human.control, room.roomId))
    }
    expectError(service.createProposal(humans[0]!.control, {
      roomId: room.roomId,
      proposal: { kind: 'abort-hand' },
    }), 'vote-not-eligible')
  })
})

describe('spectator membership and promotion', () => {
  function activeBotRoom() {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } }),
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    for (const seat of [1, 2, 3] as const) {
      room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, seat, 'bot'))
    }
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')
    return { service, ana, room }
  }

  function discardAsAna(service: RoomService, ana: SessionBootstrap, roomId: string) {
    const choices = unwrap(service.getLegalChoices(ana.control, roomId))
    const discard = choices.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected a discard')
    return unwrap(service.applyGameAction(ana.control, {
      roomId,
      handId: choices.handId,
      phaseId: choices.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }))
  }

  function passAsBot(service: RoomService, roomId: string, seat: 1 | 2 | 3) {
    const snapshot = unwrap(service.getBotDecisionSnapshot(roomId, seat))
    if (snapshot.stage !== 'playing') throw new Error('Expected bot play')
    const pass = snapshot.privateState?.legalChoices.find((choice) => choice.kind === 'pass')
    if (!pass) throw new Error('Expected a bot pass')
    return unwrap(service.applyBotGameAction({
      roomId,
      seat,
      handId: snapshot.handId,
      phaseId: snapshot.phase.phaseId,
      choiceId: pass.choiceId,
    }))
  }

  it('admits a fifth guest to a full waiting room by code without changing its roster', () => {
    const service = new RoomService(fixtureOptions())
    const humans = ['Ana', 'Ben', 'Cora', 'Dan', 'Viewer'].map((name, index) => (
      bootstrap(service, name, `socket-${index}`)
    ))
    let room = unwrap(service.createRoom(humans[0]!.control, 'unlisted'))
    for (const human of humans.slice(1, 4)) room = unwrap(service.joinRoom(human!.control, room.roomCode))
    const before = unwrap(service.getRoom(humans[0]!.control, room.roomId))
    const inspected = unwrap(service.inspectRoom(humans[4]!.control, room.roomCode))
    expect(inspected).toMatchObject({ status: 'waiting', availableSeatCount: 0, spectatorCount: 0 })

    const admitted = unwrap(service.spectateRoom(humans[4]!.control, room.roomCode))
    const view = unwrap(service.getRecipientSnapshot(humans[4]!.control, room.roomId))
    expect(admitted.roomRevision).toBe(before.roomRevision + 1)
    expect(admitted.readinessId).toBe(before.readinessId)
    expect(admitted.seats).toEqual(before.seats)
    expect(admitted.spectatorCount).toBe(1)
    expect(view.self).toEqual({ role: 'spectator', seat: null, canControl: false })
    expect(view.stage).toBe('waiting')
    expect(view).not.toHaveProperty('privateState')
    expect(unwrap(service.listPublicRooms(humans[0]!.control)).rooms).toEqual([])

    const otherHost = bootstrap(service, 'Other host', 'socket-other')
    const otherRoom = unwrap(service.createRoom(otherHost.control, 'public'))
    expectError(service.spectateRoom(humans[4]!.control, otherRoom.roomCode), 'already-seated')
    expectError(service.inspectRoom(humans[4]!.control, otherRoom.roomCode), 'already-seated')
    expectError(service.joinRoom(humans[4]!.control, otherRoom.roomCode), 'already-seated')
    expect(unwrap(service.getRoom(humans[0]!.control, room.roomId)).spectatorCount).toBe(1)
  })

  it('admits spectators between hands without adding a private hand', () => {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => {
        const initialized = initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } })
        if (!initialized.accepted) return initialized
        return abortHand(initialized.state)
      },
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    for (const seat of [1, 2, 3] as const) {
      room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, seat, 'bot'))
    }
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'between-hands') throw new Error('Expected the fixture hand to end')

    const admitted = unwrap(service.spectateRoom(viewer.control, room.roomCode))
    const view = unwrap(service.getRecipientSnapshot(viewer.control, room.roomId))
    expect(admitted.spectatorCount).toBe(1)
    expect(view.self.role).toBe('spectator')
    expect(view.stage).toBe('between-hands')
    expect(view).not.toHaveProperty('privateState')
    if (view.stage !== 'between-hands') throw new Error('Expected a public completed result')
    expect(view.result.kind).toBe('abort')
  })

  it('admits a full-table spectator with only public state and a room revision change', () => {
    const { service, ana, room } = activeBotRoom()
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')
    const phaseId = room.stage.phaseId
    const gameRevision = room.stage.gameRevision
    const readinessId = room.readinessId
    const admitted = unwrap(service.spectateRoom(viewer.control, room.roomCode))
    const snapshot = unwrap(service.getRecipientSnapshot(viewer.control, room.roomId))
    if (snapshot.stage !== 'playing') throw new Error('Expected active spectator view')

    expect(admitted.spectatorCount).toBe(1)
    expect(admitted.roomRevision).toBe(room.roomRevision + 1)
    expect(admitted.readinessId).toBe(readinessId)
    expect(admitted.stage.kind === 'playing' && admitted.stage.phaseId).toBe(phaseId)
    expect(admitted.stage.kind === 'playing' && admitted.stage.gameRevision).toBe(gameRevision)
    expect(snapshot.self).toEqual({ role: 'spectator', seat: null, canControl: false })
    expect(snapshot.spectatorCount).toBe(1)
    expect(snapshot.privateState).toBeNull()
    expect(snapshot.seats).toHaveLength(4)
    expect(snapshot.seats.map((seat) => seat.concealedCount)).toEqual(room.stage.engineState.seats.map((seat) => seat.concealedTiles.length))
    const payload = JSON.stringify(snapshot)
    for (const seat of room.stage.engineState.seats) {
      for (const tile of seat.concealedTiles) expect(payload).not.toContain(tile.tileId)
    }
    expect(payload).not.toMatch(/legalChoices|choiceId|sessionId|engineState|remainingTiles/u)
    expectError(service.getRecipientSnapshot(ana.control, id(999)), 'room-not-found')
  })

  it('keeps spectator admission and spectator mutations from changing player state', () => {
    const { service, ana, room } = activeBotRoom()
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    const admitted = unwrap(service.spectateRoom(viewer.control, room.roomCode))
    const snapshot = unwrap(service.getRecipientSnapshot(viewer.control, room.roomId))
    if (snapshot.stage !== 'playing') throw new Error('Expected active spectator view')
    const choice = unwrap(service.getLegalChoices(ana.control, room.roomId)).choices[0]
    if (!choice) throw new Error('Expected a player choice')

    expectError(service.setVisibility(viewer.control, room.roomId, admitted.roomRevision, 'unlisted'), 'invalid-controller')
    expectError(service.configureSeat(viewer.control, room.roomId, admitted.roomRevision, 1, 'available'), 'invalid-controller')
    expectError(service.setReady(viewer.control, room.roomId, room.readinessId, true), 'invalid-controller')
    expectError(service.applyGameAction(viewer.control, {
      roomId: room.roomId,
      handId: snapshot.handId,
      phaseId: snapshot.phase.phaseId,
      action: { kind: 'discard', choiceId: choice.choiceId },
    }), 'invalid-controller')
    expectError(service.createProposal(viewer.control, { roomId: room.roomId, proposal: { kind: 'abort-hand' } }), 'vote-not-eligible')
    expectError(service.getLegalChoices(viewer.control, room.roomId), 'not-seated')
    const after = unwrap(service.getRoom(ana.control, room.roomId))
    expect(after.roomRevision).toBe(admitted.roomRevision)
    expect(after.stage.kind === 'playing' && after.stage.phaseId).toBe(snapshot.phase.phaseId)
    expect(after.proposal).toBeNull()
  })

  it('counts connected sessions once, restores membership, and ignores stale disconnects', () => {
    const { service, ana, room } = activeBotRoom()
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    const admitted = unwrap(service.spectateRoom(viewer.control, room.roomCode))
    const phaseId = admitted.stage.kind === 'playing' ? admitted.stage.phaseId : null
    const superseding = unwrap(service.authenticate(viewer.reconnectCredential, 'socket-viewer-new'))
    expect(superseding.room?.spectatorCount).toBe(1)
    expect(unwrap(service.disconnect(viewer.control)).disconnected).toBe(false)
    expect(unwrap(service.getRoom(ana.control, room.roomId)).spectatorCount).toBe(1)

    const disconnected = unwrap(service.disconnect(superseding.control))
    expect(disconnected.room?.spectatorCount).toBe(0)
    expect(unwrap(service.resolveReconnectTarget(viewer.reconnectCredential)).roomId).toBe(room.roomId)
    const resumed = unwrap(service.authenticate(viewer.reconnectCredential, 'socket-viewer-returned'))
    expect(resumed.room?.spectatorCount).toBe(1)
    expect(resumed.room?.stage.kind === 'playing' && resumed.room.stage.phaseId).toBe(phaseId)
    expect(unwrap(service.getRecipientSnapshot(resumed.control, room.roomId)).self.role).toBe('spectator')
  })

  it('lets a spectator join an open pre-hand seat and preserves failed membership', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    const room = unwrap(service.createRoom(ana.control, 'public'))
    const admitted = unwrap(service.spectateRoom(viewer.control, room.roomCode))
    expectError(service.requestBotSeatTakeover(viewer.control, room.roomCode, 1), 'seat-unavailable')
    expect(unwrap(service.getRoom(ana.control, room.roomId)).spectatorCount).toBe(1)
    const joined = unwrap(service.joinRoom(viewer.control, room.roomCode))
    expect(joined.spectatorCount).toBe(0)
    expect(joined.seats[1].controller).toMatchObject({ kind: 'human', displayName: 'Viewer' })
    expect(unwrap(service.getRecipientSnapshot(viewer.control, room.roomId)).self).toEqual({
      role: 'player', seat: 1, canControl: true,
    })
    expect(joined.readinessId).not.toBe(admitted.readinessId)
  })

  it('keeps a spectator public and counted through a deferred takeover, then transfers atomically', () => {
    const { service, ana, room } = activeBotRoom()
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    unwrap(service.spectateRoom(viewer.control, room.roomCode))
    const before = room.stage.kind === 'playing' ? room.stage.engineState.seats[1] : null
    const responseRoom = discardAsAna(service, ana, room.roomId)
    const pending = unwrap(service.requestBotSeatTakeover(viewer.control, room.roomCode, 1))
    expect(pending.kind).toBe('pending')
    expect(pending.room.spectatorCount).toBe(1)
    const pendingView = unwrap(service.getRecipientSnapshot(viewer.control, room.roomId))
    if (pendingView.stage !== 'playing') throw new Error('Expected active pending-takeover view')
    expect(pendingView.self.role).toBe('spectator')
    expect(pendingView.privateState).toBeNull()
    expect(pendingView.takeoverReservations).toMatchObject([{ seat: 1, isMine: true }])

    let changed = responseRoom
    changed = passAsBot(service, room.roomId, 2)
    changed = passAsBot(service, room.roomId, 3)
    changed = passAsBot(service, room.roomId, 1)
    expect(changed.spectatorCount).toBe(0)
    const promoted = unwrap(service.getRecipientSnapshot(viewer.control, room.roomId))
    expect(promoted.self).toEqual({ role: 'player', seat: 1, canControl: true })
    if (promoted.stage !== 'playing') throw new Error('Expected promoted active play')
    expect(promoted.privateState).not.toBeNull()
    if (changed.stage.kind !== 'playing' || !promoted.privateState || !before) throw new Error('Expected promoted active play')
    expect(promoted.privateState.concealedTiles).toEqual(changed.stage.engineState.seats[1].concealedTiles)
    expect(changed.stage.engineState.seats[1].melds).toEqual(before.melds)
    expect(changed.stage.engineState.seats[1].flowers).toEqual(before.flowers)
  })

  it('cancels a spectator reservation on disconnect while retaining reconnect membership', () => {
    const { service, ana, room } = activeBotRoom()
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    unwrap(service.spectateRoom(viewer.control, room.roomCode))
    discardAsAna(service, ana, room.roomId)
    const pending = unwrap(service.requestBotSeatTakeover(viewer.control, room.roomCode, 1))
    expect(pending.kind).toBe('pending')

    const disconnected = unwrap(service.disconnect(viewer.control))
    expect(disconnected.room?.spectatorCount).toBe(0)
    expect(disconnected.room?.takeoverReservations).toEqual([])
    expect(unwrap(service.resolveReconnectTarget(viewer.reconnectCredential)).roomId).toBe(room.roomId)
    const resumed = unwrap(service.authenticate(viewer.reconnectCredential, 'socket-viewer-returned'))
    expect(resumed.room?.spectatorCount).toBe(1)
    expect(resumed.room?.takeoverReservations).toEqual([])
    expect(unwrap(service.getRecipientSnapshot(resumed.control, room.roomId)).self.role).toBe('spectator')
  })

  it('detaches on spectator leave without pausing or changing readiness', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    const room = unwrap(service.createRoom(ana.control, 'public'))
    unwrap(service.spectateRoom(viewer.control, room.roomCode))
    const left = service.leaveRoom(viewer.control, room.roomId)
    expect(left.ok && left.detachedSessionIds).toEqual([viewer.session.sessionId])
    expect(unwrap(left).spectatorCount).toBe(0)
    expect(unwrap(service.getControlledRoom(viewer.control))).toBeNull()
    expect(unwrap(service.getRoom(ana.control, room.roomId)).readinessId).toBe(room.readinessId)
  })

  it('clears disconnected spectator attachments on expiration', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const viewer = bootstrap(service, 'Viewer', 'socket-viewer')
    const room = unwrap(service.createRoom(ana.control, 'unlisted'))
    unwrap(service.spectateRoom(viewer.control, room.roomCode))
    unwrap(service.disconnect(viewer.control))
    const expiration = unwrap(service.expireRoom(room.roomId))
    expect(expiration.detachedSessionIds).toContain(viewer.session.sessionId)
    const reconnected = unwrap(service.authenticate(viewer.reconnectCredential, 'socket-viewer-returned'))
    expect(reconnected.room).toBeNull()
    expect(reconnected.roomError?.code).toBe('room-expired')
  })
})

describe('recipient-safe room snapshots', () => {
  it('projects waiting rooms without inventing an initial dealer or exposing session identity', () => {
    const service = new RoomService(fixtureOptions())
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const room = unwrap(service.createRoom(ana.control, 'public'))
    const snapshot = unwrap(service.getRecipientSnapshot(ana.control, room.roomId))

    expect(RoomSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.stage).toBe('waiting')
    expect(snapshot.seats.every((seat) => !seat.isDealer)).toBe(true)
    expect(snapshot.self).toEqual({ role: 'player', seat: 0, canControl: true })
    expect(JSON.stringify(snapshot)).not.toMatch(/sessionId|credential|engineState|wall/u)
  })

  it('gives human and bot seats only their own hand and choices at one revision', () => {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } }),
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    const ben = bootstrap(service, 'Ben', 'socket-b')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    room = unwrap(service.joinRoom(ben.control, room.roomCode))
    room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, 2, 'bot'))
    room = unwrap(service.configureSeat(ben.control, room.roomId, room.roomRevision, 3, 'bot'))
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    room = unwrap(service.setReady(ben.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')

    const anaView = unwrap(service.getRecipientSnapshot(ana.control, room.roomId))
    const benView = unwrap(service.getRecipientSnapshot(ben.control, room.roomId))
    const botView = unwrap(service.getBotDecisionSnapshot(room.roomId, 2))
    if (anaView.stage !== 'playing' || benView.stage !== 'playing' || botView.stage !== 'playing') {
      throw new Error('Expected active snapshots')
    }

    expect([anaView.roomRevision, benView.roomRevision, botView.roomRevision]).toEqual([
      room.roomRevision, room.roomRevision, room.roomRevision,
    ])
    expect(anaView.privateState?.concealedTiles).toEqual(room.stage.engineState.seats[0].concealedTiles)
    expect(benView.privateState?.concealedTiles).toEqual(room.stage.engineState.seats[1].concealedTiles)
    expect(botView.privateState?.concealedTiles).toEqual(room.stage.engineState.seats[2].concealedTiles)
    expect(anaView.privateState?.concealedTiles).not.toEqual(benView.privateState?.concealedTiles)

    const anaPayload = JSON.stringify(anaView)
    for (const tile of room.stage.engineState.wall.remainingTiles) expect(anaPayload).not.toContain(tile.tileId)
    for (const tile of room.stage.engineState.seats[1].concealedTiles) expect(anaPayload).not.toContain(tile.tileId)
    expect(anaPayload).not.toMatch(/sessionId|credential|engineState|remainingTiles|responses/u)
    expectError(service.getBotDecisionSnapshot(room.roomId, 0), 'invalid-controller')
  })

  it('publishes response completion without unresolved response contents', () => {
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, randomSource: { nextInt: () => 0 } }),
    }))
    const humans = ['Ana', 'Ben', 'Cora', 'Dan'].map((name, index) => bootstrap(service, name, `socket-${index}`))
    let room = unwrap(service.createRoom(humans[0]!.control, 'public'))
    for (const human of humans.slice(1)) room = unwrap(service.joinRoom(human.control, room.roomCode))
    for (const human of humans) room = unwrap(service.setReady(human.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'playing') throw new Error('Expected active play')

    const dealerChoices = unwrap(service.getLegalChoices(humans[0]!.control, room.roomId))
    const discard = dealerChoices.choices.find((choice) => choice.kind === 'discard')
    if (!discard) throw new Error('Expected discard')
    room = unwrap(service.applyGameAction(humans[0]!.control, {
      roomId: room.roomId,
      handId: dealerChoices.handId,
      phaseId: dealerChoices.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }))
    const responderChoices = unwrap(service.getLegalChoices(humans[1]!.control, room.roomId))
    const pass = responderChoices.choices.find((choice) => choice.kind === 'pass')
    if (!pass) throw new Error('Expected pass')
    room = unwrap(service.applyGameAction(humans[1]!.control, {
      roomId: room.roomId,
      handId: responderChoices.handId,
      phaseId: responderChoices.phaseId,
      action: { kind: 'respond-to-discard', choiceId: pass.choiceId },
    }))

    const observer = unwrap(service.getRecipientSnapshot(humans[2]!.control, room.roomId))
    if (observer.stage !== 'playing' || observer.phase.kind !== 'discard-responses') {
      throw new Error('Expected discard responses')
    }
    expect(observer.phase.respondedSeats).toEqual([1])
    expect(observer.phase).not.toHaveProperty('responses')
    expect(observer.phase).not.toHaveProperty('choice')
  })

  it('projects ended hands without private state and marks the next dealer', () => {
    const shortWall = createCanonicalTileSet().slice(0, 64)
    const service = new RoomService(fixtureOptions({
      initializeHand: () => initializeHand({ dealerSeat: 0, wall: shortWall }),
    }))
    const ana = bootstrap(service, 'Ana', 'socket-a')
    let room = unwrap(service.createRoom(ana.control, 'public'))
    for (const seat of [1, 2, 3] as const) {
      room = unwrap(service.configureSeat(ana.control, room.roomId, room.roomRevision, seat, 'bot'))
    }
    room = unwrap(service.setReady(ana.control, room.roomId, room.readinessId, true))
    if (room.stage.kind !== 'between-hands') throw new Error('Expected an exhausted hand')

    const snapshot = unwrap(service.getRecipientSnapshot(ana.control, room.roomId))
    if (snapshot.stage !== 'between-hands') throw new Error('Expected a completed snapshot')
    expect(snapshot.result).toMatchObject({ kind: 'exhaustion-draw', nextDealerSeat: 1 })
    expect(snapshot.seats.filter((seat) => seat.isDealer).map((seat) => seat.seat)).toEqual([1])
    expect(snapshot).not.toHaveProperty('privateState')
    const payload = JSON.stringify(snapshot)
    for (const seat of room.stage.engineState.seats) {
      for (const tile of seat.concealedTiles) expect(payload).not.toContain(tile.tileId)
    }
  })
})
