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
import { RealtimeCommandError } from '../realtime/RealtimeProvider.tsx'
import { RoomEntryScreen } from './RoomEntryScreen.tsx'

const realtime = vi.hoisted(() => ({
  state: null as RealtimeState | null,
  clearIssue: vi.fn(),
  inspectRoom: vi.fn(),
  resynchronize: vi.fn(),
  sendCommand: vi.fn(),
}))

vi.mock('../realtime/RealtimeProvider.tsx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../realtime/RealtimeProvider.tsx')>(),
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

function updateScreen(renderer: ReactTestRenderer) {
  act(() => renderer.update(<MemoryRouter><RoomEntryScreen roomCode="MJ2345" /></MemoryRouter>))
}

const entry = {
  roomCode: 'MJ2345', status: 'playing', isPaused: false,
  humanCount: 2, availableSeatCount: 0, takeoverSeats: [2],
} satisfies RoomEntrySummary

const pendingAcknowledgement = {
  commandId: '30000000-0000-4000-8000-000000000002',
  status: 'accepted', duplicate: false,
  result: { kind: 'takeover-pending', takeoverId: '30000000-0000-4000-8000-000000000003' },
} satisfies CommandAcknowledgement

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
    expect(realtime.inspectRoom).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('surfaces takeover contention and refreshes the available choices', async () => {
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

  it.each([
    ['room-expired', 'The room has expired.', 'This room has expired.'],
    ['room-not-found', 'The room was not found.', 'This room was not found.'],
  ] as const)('shows %s after a local pending acknowledgement', async (code, message, title) => {
    realtime.inspectRoom.mockResolvedValue(entry)
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('Finishing the current claims')

    realtime.state = readyState({ roomError: { code, message } })
    updateScreen(renderer)
    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain(title)
    expect(text).toContain(message)
    expect(text).not.toContain('Finishing the current claims')
    expect(button(renderer, 'Check again')).toBeDefined()
    expect(renderer.root.findAllByType('a').find((link) => link.props.href === '/')?.children.join('')).toBe('Return to lobby')
    act(() => renderer.unmount())
  })

  it.each(['room-expired', 'room-not-found'] as const)('shows %s after an authoritative reservation snapshot', async (code) => {
    const unseated = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false },
      privateState: null,
    })
    realtime.state = readyState({ roomSnapshot: unseated })
    const renderer = await renderScreen()
    expect(JSON.stringify(renderer.toJSON())).toContain('Finishing the current claims')

    realtime.state = readyState({ roomError: { code, message: `The room ${code}.` } })
    updateScreen(renderer)
    const text = JSON.stringify(renderer.toJSON())
    expect(text).not.toContain('Finishing the current claims')
    expect(text).not.toMatch(/concealedTiles|legalChoices|sticks-1-a/u)
    expect(button(renderer, 'Check again')).toBeDefined()
    act(() => renderer.unmount())
  })

  it('ignores a pending acknowledgement that arrives after room expiration', async () => {
    realtime.inspectRoom.mockResolvedValue(entry)
    let acknowledge!: (value: CommandAcknowledgement) => void
    realtime.sendCommand.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve }))
    const renderer = await renderScreen()
    act(() => button(renderer, 'Take over seat 3').props.onClick())

    realtime.state = readyState({ roomError: { code: 'room-expired', message: 'The room has expired.' } })
    updateScreen(renderer)
    await act(async () => { acknowledge(pendingAcknowledgement); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Finishing the current claims')
    expect(button(renderer, 'Check again')).toBeDefined()
    act(() => renderer.unmount())
  })

  it('reinspects after a terminal result without replaying the old takeover', async () => {
    realtime.inspectRoom.mockResolvedValue(entry)
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })

    realtime.state = readyState({ roomError: { code: 'room-expired', message: 'The room has expired.' } })
    updateScreen(renderer)
    realtime.clearIssue.mockImplementation(() => { realtime.state = readyState() })
    await act(async () => { button(renderer, 'Check again').props.onClick(); updateScreen(renderer); await Promise.resolve() })

    expect(realtime.inspectRoom).toHaveBeenCalledTimes(2)
    expect(realtime.sendCommand).toHaveBeenCalledTimes(1)
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(renderer.root.findByType('fieldset').props.disabled).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Finishing the current claims')
    act(() => renderer.unmount())
  })

  it('ignores an inspection response from before terminal recovery', async () => {
    let resolveOldInspection!: (value: RoomEntrySummary) => void
    realtime.inspectRoom
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldInspection = resolve }))
      .mockResolvedValueOnce(entry)
    const renderer = await renderScreen()

    realtime.state = readyState({ roomError: { code: 'room-expired', message: 'The room has expired.' } })
    updateScreen(renderer)
    realtime.clearIssue.mockImplementation(() => { realtime.state = readyState() })
    await act(async () => { button(renderer, 'Check again').props.onClick(); updateScreen(renderer); await Promise.resolve() })
    expect(button(renderer, 'Take over seat 3')).toBeDefined()

    await act(async () => {
      resolveOldInspection({ ...entry, takeoverSeats: [], availableSeatCount: 0 })
      await Promise.resolve()
    })
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Finishing the current claims')
    act(() => renderer.unmount())
  })

  it('shows a terminal inspection rejection after a pending takeover', async () => {
    realtime.inspectRoom.mockResolvedValueOnce(entry).mockRejectedValueOnce(new RealtimeCommandError({
      kind: 'server', commandId: null,
      error: { code: 'room-not-found', message: 'The room was not found.' },
    }))
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })

    realtime.state = readyState({ connectionStatus: 'disconnected' })
    updateScreen(renderer)
    realtime.state = readyState()
    await act(async () => { updateScreen(renderer); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('The room was not found.')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Finishing the current claims')
    expect(button(renderer, 'Check again')).toBeDefined()
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
