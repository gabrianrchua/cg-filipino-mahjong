import {
  COMPLETED_HAND_FIXTURE,
  WAITING_ROOM_FIXTURE,
  type CommandAcknowledgement,
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
  it('renders the authoritative roster without a privileged host seat', () => {
    const renderer = renderScreen()
    const text = JSON.stringify(renderer.toJSON())

    expect(text).toContain('Ana')
    expect(text).toContain('Ben')
    expect(text).toContain('Cora')
    expect(text).toContain('Bot player')
    expect(text).toContain('Automatically ready for every hand.')
    expect(text).toContain('Human · Connected')
    expect(text).toContain('Every seated human has the same controls')
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
})
