import { describe, expect, it } from 'vitest'

import {
  initializeHand,
} from '../game-engine/index.js'
import {
  RoomService,
  type RoomServiceOptions,
  type RoomServiceResult,
  type SessionBootstrap,
} from './index.js'

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

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
    const joined = unwrap(service.joinRoom(ben.control, `  ${room.roomCode.toLowerCase()}  `))
    expect(joined.seats[1].controller).toMatchObject({ kind: 'human', displayName: 'Ben' })

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
    }])
    expect(publicRoom.visibility).toBe('public')
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
    const replaced = unwrap(service.commitApprovedBotReplacement(room.roomId, 1))
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
})
