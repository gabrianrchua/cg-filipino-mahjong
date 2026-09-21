import {
  DEFERRED_TAKEOVER_FIXTURE,
  RoomSnapshotSchema,
  type CommandAcknowledgement,
  type RoomEntrySeat,
  type RoomEntrySummary,
} from '@cg-filipino-mahjong/shared'
import { StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_REALTIME_STATE, type RealtimeState } from '../realtime/state.ts'
import { RealtimeCommandError } from '../realtime/RealtimeProvider.tsx'
import { RoomEntryScreen } from './RoomEntryScreen.tsx'

const pendingAcknowledgement = {
  commandId: '30000000-0000-4000-8000-000000000002',
  status: 'accepted', duplicate: false,
  result: { kind: 'takeover-pending', takeoverId: '30000000-0000-4000-8000-000000000003' },
} satisfies CommandAcknowledgement

const playingSeats = [
  { seat: 0, kind: 'human', displayName: 'Ana', connection: 'connected' },
  { seat: 1, kind: 'human', displayName: 'Ben', connection: 'disconnected' },
  { seat: 2, kind: 'bot', takeoverAvailable: true },
  { seat: 3, kind: 'bot', takeoverAvailable: false },
] satisfies RoomEntrySeat[]

const playingEntry = {
  roomCode: 'MJ2345', status: 'playing', isPaused: true,
  humanCount: 2, availableSeatCount: 0, takeoverSeats: [2], seats: playingSeats,
} satisfies RoomEntrySummary

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

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
    renderer = create(<MemoryRouter><RoomEntryScreen key="MJ2345" roomCode="MJ2345" /></MemoryRouter>)
    await Promise.resolve()
  })
  return renderer
}

async function updateScreen(renderer: ReactTestRenderer, state: RealtimeState, roomCode = 'MJ2345') {
  realtime.state = state
  await act(async () => {
    renderer.update(<MemoryRouter><RoomEntryScreen key={roomCode} roomCode={roomCode} /></MemoryRouter>)
    await Promise.resolve()
  })
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
  it('completes one inspection in development Strict Mode', async () => {
    realtime.inspectRoom.mockResolvedValue(playingEntry)
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<StrictMode><MemoryRouter><RoomEntryScreen roomCode="MJ2345" /></MemoryRouter></StrictMode>)
      await Promise.resolve()
    })
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(realtime.inspectRoom).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('shows human connection and bot takeover status without private state', async () => {
    realtime.inspectRoom.mockResolvedValue(playingEntry)
    const renderer = await renderScreen()
    const rendered = JSON.stringify(renderer.toJSON())
    expect(rendered).toContain('Ana')
    expect(rendered).toContain('Ben')
    expect(rendered).toContain('Bot 3')
    expect(rendered).toContain('Bot 4')
    expect(rendered).toContain('Disconnected · reserved')
    expect(rendered).toContain('Takeover pending')
    expect(rendered).not.toMatch(/privateState|concealedTiles|sessionId/u)
    act(() => renderer.unmount())
  })

  it('offers ordinary entry and every server-listed bot seat together', async () => {
    realtime.inspectRoom.mockResolvedValue({
      roomCode: 'MJ2345', status: 'waiting', isPaused: false,
      humanCount: 1, availableSeatCount: 1, takeoverSeats: [2, 3],
      seats: [
        { seat: 0, kind: 'human', displayName: 'Ana', connection: 'connected' },
        { seat: 1, kind: 'available' },
        { seat: 2, kind: 'bot', takeoverAvailable: true },
        { seat: 3, kind: 'bot', takeoverAvailable: true },
      ],
    } satisfies RoomEntrySummary)
    const renderer = await renderScreen()

    expect(button(renderer, 'Join an open seat')).toBeDefined()
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(button(renderer, 'Take over seat 4')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('Open seat')
    expect(JSON.stringify(renderer.toJSON())).toContain('Ana')
    expect(JSON.stringify(renderer.toJSON())).toContain('Bot 3')
    expect(JSON.stringify(renderer.toJSON())).toContain('Bot 4')
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

    expect(text).toContain('Waiting to take over seat 3')
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toBe('Takeover requested')
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
      ...playingEntry,
    } satisfies RoomEntrySummary
    realtime.inspectRoom.mockResolvedValueOnce(entry).mockResolvedValueOnce({
      ...entry,
      takeoverSeats: [3],
      seats: [
        playingSeats[0], playingSeats[1],
        { seat: 2, kind: 'bot', takeoverAvailable: false },
        { seat: 3, kind: 'bot', takeoverAvailable: true },
      ],
    })
    realtime.sendCommand.mockResolvedValue({
      commandId: '30000000-0000-4000-8000-000000000002',
      status: 'rejected', duplicate: false,
      error: { code: 'takeover-pending', message: 'Another guest already requested this seat.' },
    } satisfies CommandAcknowledgement)
    const renderer = await renderScreen()

    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    expect(realtime.sendCommand).toHaveBeenCalledWith({ type: 'room.takeover', roomCode: 'MJ2345', seat: 2 })
    expect(button(renderer, 'Take over seat 4')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).toContain('Takeover pending')
    expect(realtime.inspectRoom).toHaveBeenCalledTimes(2)
    act(() => renderer.unmount())
  })

  it.each([
    ['room-expired', 'The room has expired.', 'This room has expired.'],
    ['room-not-found', 'The room was not found.', 'This room was not found.'],
  ] as const)('shows %s after a local pending acknowledgement', async (code, message, title) => {
    realtime.inspectRoom.mockResolvedValue(playingEntry)
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('Waiting to take over seat 3')

    await updateScreen(renderer, readyState({ roomError: { code, message } }))
    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain(title)
    expect(text).toContain(message)
    expect(text).not.toContain('Waiting to take over seat 3')
    expect(button(renderer, 'Check again')).toBeDefined()
    expect(renderer.root.findAllByType('a').find((link) => link.props.href === '/')?.children.join('')).toBe('Return to lobby')
    act(() => renderer.unmount())
  })

  it.each(['room-expired', 'room-not-found'] as const)('shows %s after an authoritative reservation snapshot', async (code) => {
    const unseated = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false }, privateState: null,
    })
    realtime.state = readyState({ roomSnapshot: unseated })
    const renderer = await renderScreen()
    expect(JSON.stringify(renderer.toJSON())).toContain('Waiting to take over seat 3')

    await updateScreen(renderer, readyState({ roomError: { code, message: `The room ${code}.` } }))
    const text = JSON.stringify(renderer.toJSON())
    expect(text).not.toContain('Waiting to take over seat 3')
    expect(text).not.toMatch(/concealedTiles|legalChoices|sticks-1-a/u)
    expect(button(renderer, 'Check again')).toBeDefined()
    act(() => renderer.unmount())
  })

  it('ignores a pending acknowledgement that arrives after room expiration', async () => {
    const acknowledgement = deferred<CommandAcknowledgement>()
    realtime.inspectRoom.mockResolvedValue(playingEntry)
    realtime.sendCommand.mockReturnValue(acknowledgement.promise)
    const renderer = await renderScreen()
    act(() => button(renderer, 'Take over seat 3').props.onClick())

    await updateScreen(renderer, readyState({ roomError: { code: 'room-expired', message: 'The room has expired.' } }))
    await act(async () => { acknowledgement.resolve(pendingAcknowledgement); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Waiting to take over seat 3')
    expect(button(renderer, 'Check again')).toBeDefined()
    act(() => renderer.unmount())
  })

  it('reinspects after a terminal result without replaying the old takeover', async () => {
    realtime.inspectRoom.mockResolvedValue(playingEntry)
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })

    await updateScreen(renderer, readyState({ roomError: { code: 'room-expired', message: 'The room has expired.' } }))
    await act(async () => { button(renderer, 'Check again').props.onClick(); await Promise.resolve() })
    await updateScreen(renderer, readyState())

    expect(realtime.inspectRoom).toHaveBeenCalledTimes(2)
    expect(realtime.sendCommand).toHaveBeenCalledTimes(1)
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(renderer.root.findByType('fieldset').props.disabled).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Waiting to take over seat 3')
    act(() => renderer.unmount())
  })

  it('ignores an inspection response from before terminal recovery', async () => {
    const oldInspection = deferred<RoomEntrySummary>()
    realtime.inspectRoom.mockReturnValueOnce(oldInspection.promise).mockResolvedValueOnce(playingEntry)
    const renderer = await renderScreen()

    await updateScreen(renderer, readyState({ roomError: { code: 'room-expired', message: 'The room has expired.' } }))
    await act(async () => { button(renderer, 'Check again').props.onClick(); await Promise.resolve() })
    await updateScreen(renderer, readyState())
    expect(button(renderer, 'Take over seat 3')).toBeDefined()

    await act(async () => {
      oldInspection.resolve({ ...playingEntry, takeoverSeats: [], availableSeatCount: 0 })
      await Promise.resolve()
    })
    expect(button(renderer, 'Take over seat 3')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Waiting to take over seat 3')
    act(() => renderer.unmount())
  })

  it('shows a terminal inspection rejection after a pending takeover', async () => {
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry).mockRejectedValueOnce(new RealtimeCommandError({
      kind: 'server', commandId: null,
      error: { code: 'room-not-found', message: 'The room was not found.' },
    }))
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })

    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected' }))
    await updateScreen(renderer, readyState())
    expect(JSON.stringify(renderer.toJSON())).toContain('The room was not found.')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Waiting to take over seat 3')
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
    expect(text).not.toContain('Waiting to take over seat 3')
    act(() => renderer.unmount())
  })

  it.each([
    { name: 'another bot seat', recovered: { ...playingEntry, takeoverSeats: [1] }, buttonLabel: 'Take over seat 2', command: { type: 'room.takeover', roomCode: 'MJ2345', seat: 1 } },
    { name: 'an ordinary seat', recovered: { ...playingEntry, status: 'waiting' as const, availableSeatCount: 1, takeoverSeats: [] }, buttonLabel: 'Join an open seat', command: { type: 'room.join', roomCode: 'MJ2345' } },
  ])('re-enables $name after confirmed cancellation', async ({ recovered, buttonLabel, command }) => {
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry).mockResolvedValueOnce(recovered)
    realtime.sendCommand.mockResolvedValueOnce(pendingAcknowledgement).mockResolvedValueOnce(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('Waiting to take over seat 3')

    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    await updateScreen(renderer, readyState())

    expect(JSON.stringify(renderer.toJSON())).toContain('Your previous takeover request was canceled.')
    expect(button(renderer, buttonLabel).props.disabled ?? false).toBe(false)
    await act(async () => { button(renderer, buttonLabel).props.onClick(); await Promise.resolve() })
    expect(realtime.sendCommand).toHaveBeenLastCalledWith(command)
    act(() => renderer.unmount())
  })

  it('shows no admission control when inspection reports no seats', async () => {
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry).mockResolvedValueOnce({ ...playingEntry, takeoverSeats: [] })
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    await updateScreen(renderer, readyState())

    expect(JSON.stringify(renderer.toJSON())).toContain('Your previous takeover request was canceled.')
    expect(JSON.stringify(renderer.toJSON())).toContain('This room has no open human seat or available bot takeover.')
    expect(renderer.root.findAllByType('button').filter((candidate) => candidate.children.join('').includes('Take over'))).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('keeps an authoritative reservation waiting across reconnects', async () => {
    realtime.inspectRoom.mockResolvedValue(playingEntry)
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    const unseated = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false }, privateState: null,
    })
    await updateScreen(renderer, readyState({ roomSnapshot: unseated, hasReceivedLobby: false }))
    expect(JSON.stringify(renderer.toJSON())).toContain('Waiting to take over seat 3')
    expect(realtime.inspectRoom).toHaveBeenCalledTimes(1)
    expect(realtime.sendCommand).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('remembers a pending acknowledgement after its reservation snapshot arrives first', async () => {
    const acknowledgement = deferred<CommandAcknowledgement>()
    const reservation = RoomSnapshotSchema.parse({
      ...DEFERRED_TAKEOVER_FIXTURE,
      self: { seat: null, canControl: false }, privateState: null,
    })
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry).mockResolvedValueOnce({ ...playingEntry, takeoverSeats: [1] })
    realtime.sendCommand.mockReturnValue(acknowledgement.promise)
    const renderer = await renderScreen()
    act(() => { button(renderer, 'Take over seat 3').props.onClick() })
    await updateScreen(renderer, readyState({ roomSnapshot: reservation }))
    await act(async () => { acknowledgement.resolve(pendingAcknowledgement); await Promise.resolve() })
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false, roomSnapshot: reservation }))
    await updateScreen(renderer, readyState())

    expect(JSON.stringify(renderer.toJSON())).toContain('Your previous takeover request was canceled.')
    expect(button(renderer, 'Take over seat 2').props.disabled ?? false).toBe(false)
    act(() => renderer.unmount())
  })

  it('offers retry after a failed recovery inspection without assuming cancellation', async () => {
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry)
      .mockRejectedValueOnce(new Error('The room could not be checked.'))
      .mockResolvedValueOnce({ ...playingEntry, takeoverSeats: [1] })
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    await updateScreen(renderer, readyState())
    expect(JSON.stringify(renderer.toJSON())).toContain('The room could not be checked.')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Your previous takeover request was canceled.')

    await act(async () => { button(renderer, 'Check again').props.onClick(); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('Your previous takeover request was canceled.')
    expect(button(renderer, 'Take over seat 2').props.disabled ?? false).toBe(false)
    act(() => renderer.unmount())
  })

  it('ignores inspection results from an earlier reconnect', async () => {
    const oldInspection = deferred<RoomEntrySummary>()
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry)
      .mockReturnValueOnce(oldInspection.promise)
      .mockResolvedValueOnce({ ...playingEntry, takeoverSeats: [1] })
    realtime.sendCommand.mockResolvedValue(pendingAcknowledgement)
    const renderer = await renderScreen()
    await act(async () => { button(renderer, 'Take over seat 3').props.onClick(); await Promise.resolve() })
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    await updateScreen(renderer, readyState())
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    await updateScreen(renderer, readyState())
    await act(async () => { oldInspection.resolve({ ...playingEntry, takeoverSeats: [3] }); await Promise.resolve() })

    expect(button(renderer, 'Take over seat 2').props.disabled ?? false).toBe(false)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Take over seat 4')
    expect(realtime.inspectRoom).toHaveBeenCalledTimes(3)
    act(() => renderer.unmount())
  })

  it('ignores late admission and inspection results from an older flow', async () => {
    const oldCommand = deferred<CommandAcknowledgement>()
    const newCommand = deferred<CommandAcknowledgement>()
    realtime.inspectRoom.mockResolvedValueOnce(playingEntry).mockResolvedValueOnce(playingEntry)
    realtime.sendCommand.mockReturnValueOnce(oldCommand.promise).mockReturnValueOnce(newCommand.promise)
    const renderer = await renderScreen()
    act(() => {
      button(renderer, 'Take over seat 3').props.onClick()
      button(renderer, 'Take over seat 3').props.onClick()
    })
    expect(realtime.sendCommand).toHaveBeenCalledTimes(1)
    await updateScreen(renderer, readyState({ connectionStatus: 'disconnected', hasReceivedLobby: false }))
    await updateScreen(renderer, readyState())
    expect(button(renderer, 'Take over seat 3').props.disabled ?? false).toBe(false)
    act(() => { button(renderer, 'Take over seat 3').props.onClick() })
    await act(async () => { oldCommand.resolve(pendingAcknowledgement); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Waiting to take over seat 3')
    expect(renderer.root.findByType('fieldset').props.disabled).toBe(true)
    await act(async () => { newCommand.resolve(pendingAcknowledgement); await Promise.resolve() })
    expect(realtime.sendCommand).toHaveBeenCalledTimes(2)
    act(() => renderer.unmount())
  })

  it('ignores an old room inspection after the route changes', async () => {
    const oldInspection = deferred<RoomEntrySummary>()
    realtime.inspectRoom.mockReturnValueOnce(oldInspection.promise).mockResolvedValueOnce({
      roomCode: 'ABC234', status: 'waiting', isPaused: false,
      humanCount: 1, availableSeatCount: 1, takeoverSeats: [],
      seats: [
        { seat: 0, kind: 'human', displayName: 'Cora', connection: 'connected' },
        { seat: 1, kind: 'available' },
        { seat: 2, kind: 'bot', takeoverAvailable: false },
        { seat: 3, kind: 'bot', takeoverAvailable: false },
      ],
    } satisfies RoomEntrySummary)
    const renderer = await renderScreen()
    await updateScreen(renderer, readyState(), 'ABC234')
    await act(async () => { oldInspection.resolve(playingEntry); await Promise.resolve() })
    expect(JSON.stringify(renderer.toJSON())).toContain('ABC234')
    expect(button(renderer, 'Join an open seat')).toBeDefined()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Take over seat 3')
    act(() => renderer.unmount())
  })
})
