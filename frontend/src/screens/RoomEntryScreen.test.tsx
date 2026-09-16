import {
  DEFERRED_TAKEOVER_FIXTURE,
  RoomSnapshotSchema,
  type CommandAcknowledgement,
  type RoomEntrySummary,
} from '@cg-filipino-mahjong/shared'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_REALTIME_STATE, type RealtimeState } from '../realtime/state.ts'
import { RoomEntryScreen } from './RoomEntryScreen.tsx'

const realtime = vi.hoisted(() => ({
  state: null as RealtimeState | null,
  clearIssue: vi.fn(),
  inspectRoom: vi.fn(),
  resynchronize: vi.fn(),
  sendCommand: vi.fn(),
}))

vi.mock('../realtime/RealtimeProvider.tsx', () => ({
  useRealtimeState: () => realtime.state,
  useRealtimeActions: () => ({
    clearIssue: realtime.clearIssue,
    inspectRoom: realtime.inspectRoom,
    resynchronize: realtime.resynchronize,
    sendCommand: realtime.sendCommand,
  }),
}))

function readyState(overrides: Partial<RealtimeState> = {}): RealtimeState {
  return {
    ...INITIAL_REALTIME_STATE,
    connectionStatus: 'connected',
    sessionStatus: 'ready',
    sessionId: '30000000-0000-4000-8000-000000000001',
    hasReceivedLobby: true,
    ...overrides,
  }
}

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<MemoryRouter><RoomEntryScreen roomCode="MJ2345" /></MemoryRouter>)
    await Promise.resolve()
  })
  return renderer
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find((candidate) => candidate.children.join('') === label)!
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.clearAllMocks()
  realtime.state = readyState()
})

describe('room entry screen takeover flow', () => {
  it('offers ordinary entry and every server-listed bot seat together', async () => {
    realtime.inspectRoom.mockResolvedValue({
      roomCode: 'MJ2345', status: 'waiting', isPaused: false,
      humanCount: 1, availableSeatCount: 1, takeoverSeats: [2, 3],
    } satisfies RoomEntrySummary)
    const renderer = await renderScreen()

    expect(button(renderer, 'Join an open seat')).toBeDefined()
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(button(renderer, 'Take over seat 4')).toBeDefined()
    act(() => renderer.unmount())
  })

  it('shows a deferred reservation without rendering private seat state', async () => {
    const unseated = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false },
      privateState: null,
    })
    realtime.state = readyState({ roomSnapshot: unseated })
    const renderer = await renderScreen()
    const text = JSON.stringify(renderer.toJSON())

    expect(text).toContain('Finishing the current claims')
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toBe('Waiting to take over seat 3.')
    expect(text).not.toMatch(/concealedTiles|legalChoices|sticks-1-a/u)
    expect(button(renderer, 'Cancel takeover')).toBeDefined()
    expect(realtime.inspectRoom).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('cancels a deferred takeover through the current room ID', async () => {
    const unseated = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false },
      privateState: null,
    })
    realtime.state = readyState({ roomSnapshot: unseated })
    realtime.sendCommand.mockResolvedValue({
      commandId: '30000000-0000-4000-8000-000000000002',
      status: 'accepted', duplicate: false,
      result: { kind: 'room-departure', disposition: 'detached', roomRevision: unseated.roomRevision + 1 },
    } satisfies CommandAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Cancel takeover').props.onClick(); await Promise.resolve() })
    expect(realtime.sendCommand).toHaveBeenCalledWith({ type: 'room.leave', roomId: unseated.roomId })
    act(() => renderer.unmount())
  })

  it('surfaces takeover contention and refreshes the available choices', async () => {
    const entry = {
      roomCode: 'MJ2345', status: 'playing', isPaused: false,
      humanCount: 2, availableSeatCount: 0, takeoverSeats: [2],
    } satisfies RoomEntrySummary
    realtime.inspectRoom.mockResolvedValue(entry)
    realtime.sendCommand.mockResolvedValue({
      commandId: '30000000-0000-4000-8000-000000000002',
      status: 'rejected', duplicate: false,
      error: { code: 'takeover-pending', message: 'Another guest already requested this seat.' },
    } satisfies CommandAcknowledgement)
    const renderer = await renderScreen()

    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('Another guest already requested this seat.')
    expect(realtime.sendCommand).toHaveBeenCalledWith({ type: 'room.takeover', roomCode: 'MJ2345', seat: 2 })
    act(() => renderer.unmount())
  })

  it('shows local network loss before a stale deferred reservation', async () => {
    const unseated = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false },
      privateState: null,
    })
    realtime.state = readyState({ connectionStatus: 'disconnected', roomSnapshot: unseated })
    const renderer = await renderScreen()

    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain('We couldn’t check this room.')
    expect(text).not.toContain('Finishing the current claims')
    act(() => renderer.unmount())
  })
})
