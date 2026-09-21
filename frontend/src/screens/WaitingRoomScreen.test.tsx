import {
  COMPLETED_HAND_FIXTURE,
  RoomSnapshotSchema,
  WAITING_ROOM_FIXTURE,
  type BetweenHandsSnapshot,
  type CommandAcknowledgement,
  type HandResult,
} from '@cg-filipino-mahjong/shared'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_REALTIME_STATE, type RealtimeState } from '../realtime/state.ts'
import { WaitingRoomScreen } from './WaitingRoomScreen.tsx'

const realtime = vi.hoisted(() => ({
  state: null as RealtimeState | null,
  sendCommand: vi.fn(),
  resynchronize: vi.fn(),
}))

vi.mock('../realtime/RealtimeProvider.tsx', () => ({
  useRealtimeState: () => realtime.state,
  useRealtimeActions: () => ({
    sendCommand: realtime.sendCommand,
    resynchronize: realtime.resynchronize,
  }),
}))

function readyState(snapshot = WAITING_ROOM_FIXTURE): RealtimeState {
  return {
    ...INITIAL_REALTIME_STATE,
    connectionStatus: 'connected',
    sessionStatus: 'ready',
    roomSnapshot: snapshot,
  }
}

function completedWith(result: HandResult): BetweenHandsSnapshot {
  const seats = COMPLETED_HAND_FIXTURE.seats.map((seat) => ({
    ...seat,
    isDealer: seat.seat === result.nextDealerSeat,
  }))
  const snapshot = RoomSnapshotSchema.parse({ ...COMPLETED_HAND_FIXTURE, seats, result })
  if (snapshot.stage !== 'between-hands') throw new Error('Expected a between-hands fixture')
  return snapshot
}

const suited = (tileId: string, suit: 'sticks' | 'balls' | 'characters', rank: number) => ({
  tileId, kind: 'suited' as const, suit, rank,
})

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      <MemoryRouter initialEntries={['/room/MJ2345']}>
        <WaitingRoomScreen roomCode="MJ2345" />
      </MemoryRouter>,
    )
  })
  return renderer
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find((candidate) => candidate.props.children === label)!
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  realtime.state = readyState()
  realtime.sendCommand.mockReset()
  realtime.resynchronize.mockReset()
})

describe('waiting room screen', () => {
  it('offers one explicit leave command and keeps the control pending until acknowledgement', async () => {
    let resolve!: (acknowledgement: CommandAcknowledgement) => void
    realtime.sendCommand.mockReturnValue(new Promise<CommandAcknowledgement>((done) => { resolve = done }))
    const renderer = renderScreen()
    const leave = button(renderer, 'Leave room')
    act(() => { leave.props.onClick(); leave.props.onClick() })
    expect(realtime.sendCommand).toHaveBeenCalledTimes(1)
    expect(realtime.sendCommand).toHaveBeenCalledWith({ type: 'room.leave', roomId: WAITING_ROOM_FIXTURE.roomId })
    expect(button(renderer, 'Leaving…').props.disabled).toBe(true)
    await act(async () => {
      resolve({
        commandId: '00000000-0000-4000-8000-000000000101', status: 'accepted', duplicate: false,
        result: { kind: 'room-departure', disposition: 'detached', roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 1 },
      })
      await Promise.resolve()
    })
    act(() => renderer.unmount())
  })

  it('renders the room roster with concise controller states', () => {
    const renderer = renderScreen()
    const text = JSON.stringify(renderer.toJSON())

    expect(text).toContain('Ana')
    expect(text).toContain('Ben')
    expect(text).toContain('Cora')
    expect(text).toContain('Bot 3')
    expect(text).toContain('Not ready')
    expect(text).toContain('Ready')
    expect(renderer.root.findAllByType('article')).toHaveLength(4)

    act(() => renderer.unmount())
  })

  it('submits one ready command even when the control is activated twice before rerender', async () => {
    let resolve!: (acknowledgement: CommandAcknowledgement) => void
    realtime.sendCommand.mockReturnValue(new Promise<CommandAcknowledgement>((done) => { resolve = done }))
    const renderer = renderScreen()
    const ready = button(renderer, 'I’m ready')

    act(() => {
      ready.props.onClick()
      ready.props.onClick()
    })

    expect(realtime.sendCommand).toHaveBeenCalledTimes(1)
    expect(realtime.sendCommand).toHaveBeenCalledWith({
      type: 'room.set-ready',
      roomId: WAITING_ROOM_FIXTURE.roomId,
      readinessId: WAITING_ROOM_FIXTURE.readinessId,
      ready: true,
    })

    await act(async () => {
      resolve({
        commandId: '00000000-0000-4000-8000-000000000101',
        status: 'accepted',
        duplicate: false,
        result: { kind: 'completed' },
      })
      await Promise.resolve()
    })
    act(() => renderer.unmount())
  })

  it('shows a server rejection and retains authoritative controls', async () => {
    realtime.sendCommand.mockResolvedValue({
      commandId: '00000000-0000-4000-8000-000000000101',
      status: 'rejected',
      duplicate: false,
      error: { code: 'stale-room', message: 'The room has changed.' },
    })
    const renderer = renderScreen()

    await act(async () => {
      button(renderer, 'Make available').props.onClick()
      await Promise.resolve()
    })

    expect(realtime.sendCommand).toHaveBeenCalledWith({
      type: 'room.configure-seat',
      roomId: WAITING_ROOM_FIXTURE.roomId,
      expectedRoomRevision: WAITING_ROOM_FIXTURE.roomRevision,
      seat: 2,
      controller: 'available',
    })
    expect(renderer.root.findByProps({ role: 'alert' }).props.children).toBe('The room has changed.')
    expect(button(renderer, 'Make available').props.disabled).toBe(false)

    act(() => renderer.unmount())
  })

  it('reuses the room roster and readiness controls between hands', () => {
    realtime.state = readyState(COMPLETED_HAND_FIXTURE)
    const renderer = renderScreen()

    expect(renderer.root.findByType('h1').props.children).toBe('Ready for another hand?')
    expect(button(renderer, 'I’m ready')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('MJ2345')

    act(() => renderer.unmount())
  })

  it('shows an authoritative regular self-draw result and its physical-tile decomposition', () => {
    realtime.state = readyState(COMPLETED_HAND_FIXTURE)
    const renderer = renderScreen()
    const text = JSON.stringify(renderer.toJSON())

    expect(renderer.root.findByProps({ id: 'hand-result-title' }).children.join('')).toBe('Ana wins by self-draw.')
    expect(text).toContain('Seven of characters')
    expect(text).toContain('Regular hand')
    expect(text).toContain('Winning decomposition')
    expect(text).toContain('Next dealer')
    expect(renderer.root.findAll((node) => typeof node.props['aria-label'] === 'string'
      && /^(Pair|Chow|Pong|Káng):/u.test(node.props['aria-label']))).toHaveLength(6)
    expect(renderer.root.findAllByProps({ 'data-tile-id': 'characters-7-c' }).length).toBeGreaterThanOrEqual(2)
    expect(text).not.toMatch(/payout|losing hand/iu)

    act(() => renderer.unmount())
  })

  it('shows a discard win with the alternate decomposition and advanced dealer', () => {
    const pairs = Array.from({ length: 7 }, (_, index) => ({
      kind: 'pair' as const,
      tiles: [
        suited(`alternate-pair-${index}-a`, index < 3 ? 'balls' : index < 5 ? 'sticks' : 'characters', (index % 3) + 1),
        suited(`alternate-pair-${index}-b`, index < 3 ? 'balls' : index < 5 ? 'sticks' : 'characters', (index % 3) + 1),
      ],
    }))
    const pong = {
      kind: 'pong' as const,
      tiles: [0, 1, 2].map((copy) => suited(`alternate-pong-${copy}`, 'characters', 9)),
    }
    realtime.state = readyState(completedWith({
      kind: 'win',
      winnerSeat: 1,
      source: 'discard',
      winningTile: pong.tiles[2]!,
      decomposition: { kind: 'seven-pairs-plus-pong', groups: [...pairs, pong] },
      nextDealerSeat: 1,
    }))
    const renderer = renderScreen()
    const text = JSON.stringify(renderer.toJSON())

    expect(renderer.root.findByProps({ id: 'hand-result-title' }).children.join('')).toBe('Ben wins on a discard.')
    expect(text).toContain('Seven pairs plus a pong')
    expect(text).toContain('Next dealer')
    expect(renderer.root.findAll((node) => typeof node.props['aria-label'] === 'string'
      && /^(Pair|Pong):/u.test(node.props['aria-label']))).toHaveLength(8)

    act(() => renderer.unmount())
  })

  it.each([
    [{ kind: 'exhaustion-draw', nextDealerSeat: 1 } as const, 'The wall is exhausted.', 'Next dealer', 'Ben'],
    [{ kind: 'exhaustion-draw', nextDealerSeat: 2 } as const, 'The wall is exhausted.', 'Next dealer', 'Bot 3'],
    [{ kind: 'abort', nextDealerSeat: 0 } as const, 'The hand was aborted.', 'Dealer remains', 'Ana'],
  ])('shows non-winning result %s without a decomposition', (result, heading, dealerLabel, dealerName) => {
    realtime.state = readyState(completedWith(result))
    const renderer = renderScreen()
    const text = JSON.stringify(renderer.toJSON())

    expect(text).toContain(heading)
    expect(text).toContain(dealerLabel)
    expect(text).toContain(dealerName)
    expect(text).not.toContain('Winning decomposition')

    act(() => renderer.unmount())
  })

  it('keeps result context visible while reconnecting and disables readiness', () => {
    realtime.state = {
      ...readyState(COMPLETED_HAND_FIXTURE),
      connectionStatus: 'disconnected',
    }
    const renderer = renderScreen()

    expect(renderer.root.findByProps({ id: 'hand-result-title' }).children.join('')).toBe('Ana wins by self-draw.')
    expect(button(renderer, 'I’m ready').props.disabled).toBe(true)
    expect(button(renderer, 'Reconnect')).toBeDefined()

    act(() => renderer.unmount())
  })
})
