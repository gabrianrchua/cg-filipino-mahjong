import {
  PAUSED_PROPOSAL_FIXTURE,
  RoomSnapshotSchema,
  WAITING_ROOM_FIXTURE,
  type CommandAcknowledgement,
  type RoomSnapshot,
} from '@cg-filipino-mahjong/shared'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_REALTIME_STATE, type RealtimeState } from '../realtime/state.ts'
import { RoomInterruptionDialog } from './RoomInterruptionDialog.tsx'

vi.mock('@radix-ui/react-dialog', () => ({
  Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Overlay: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Content: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
  Title: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h1 {...props} />,
  Description: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
}))

const realtime = vi.hoisted(() => ({
  state: null as RealtimeState | null,
  sendCommand: vi.fn(),
  resynchronize: vi.fn(),
}))

vi.mock('../realtime/RealtimeProvider.tsx', () => ({
  useRealtimeState: () => realtime.state,
  useRealtimeActions: () => ({ sendCommand: realtime.sendCommand, resynchronize: realtime.resynchronize }),
}))

function activeState(snapshot: RoomSnapshot): RealtimeState {
  return {
    ...INITIAL_REALTIME_STATE,
    connectionStatus: 'connected',
    sessionStatus: 'ready',
    sessionId: '30000000-0000-4000-8000-000000000001',
    roomSnapshot: snapshot,
  }
}

function renderDialog(snapshot: RoomSnapshot): ReactTestRenderer {
  realtime.state = activeState(snapshot)
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<RoomInterruptionDialog snapshot={snapshot} />) })
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
  realtime.sendCommand.mockResolvedValue({
    commandId: '30000000-0000-4000-8000-000000000002',
    status: 'accepted',
    duplicate: false,
    result: { kind: 'completed' },
  } satisfies CommandAcknowledgement)
})

describe('room interruption dialog', () => {
  it('shows the authoritative proposal and submits eligible votes', async () => {
    const renderer = renderDialog(PAUSED_PROPOSAL_FIXTURE)
    const text = JSON.stringify(renderer.toJSON())

    expect(text).toContain('Cora')
    expect(text).toContain('Replace Cora with a bot')
    expect(renderer.root.findAllByProps({ role: 'status' }).some((node) => node.children.join('') === '1 of 2 approvals')).toBe(true)
    expect(button(renderer, 'Approved').props.disabled).toBe(true)

    await act(async () => { button(renderer, 'Reject proposal').props.onClick(); await Promise.resolve() })
    expect(realtime.sendCommand).toHaveBeenCalledWith({
      type: 'proposal.vote',
      roomId: PAUSED_PROPOSAL_FIXTURE.roomId,
      proposalId: PAUSED_PROPOSAL_FIXTURE.proposal!.proposalId,
      vote: 'reject',
    })
    act(() => renderer.unmount())
  })

  it('offers replacement during waiting but never offers abort outside an active hand', async () => {
    const pausedWaiting = RoomSnapshotSchema.parse({
      ...WAITING_ROOM_FIXTURE,
      roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 1,
      pause: { isPaused: true, disconnectedSeats: [1] },
      seats: WAITING_ROOM_FIXTURE.seats.map((seat) => seat.seat === 1
        ? { ...seat, controller: { ...seat.controller, connection: 'disconnected' } }
        : seat),
    })
    const renderer = renderDialog(pausedWaiting)

    expect(button(renderer, 'Replace Ben with a bot')).toBeDefined()
    expect(button(renderer, 'Leave room')).toBeDefined()
    expect(renderer.root.findAllByType('button').some((candidate) => candidate.children.join('') === 'Propose aborting the hand')).toBe(false)
    await act(async () => { button(renderer, 'Replace Ben with a bot').props.onClick(); await Promise.resolve() })
    expect(realtime.sendCommand).toHaveBeenCalledWith({
      type: 'proposal.create', roomId: pausedWaiting.roomId,
      proposal: { kind: 'replace-with-bot', targetSeat: 1 },
    })
    act(() => renderer.unmount())
  })

  it('lists and offers separate replacements for multiple missing players', () => {
    const multipleMissing = RoomSnapshotSchema.parse({
      ...PAUSED_PROPOSAL_FIXTURE,
      roomRevision: PAUSED_PROPOSAL_FIXTURE.roomRevision + 1,
      proposal: null,
      pause: { isPaused: true, disconnectedSeats: [1, 3] },
      seats: PAUSED_PROPOSAL_FIXTURE.seats.map((seat) => (
        seat.seat === 1 || seat.seat === 3
          ? { ...seat, controller: { ...seat.controller, connection: 'disconnected' } }
          : seat
      )),
    })
    const renderer = renderDialog(multipleMissing)

    expect(renderer.root.findByType('h1').children.join('')).toBe('2 players are disconnected.')
    expect(button(renderer, 'Replace Ben with a bot')).toBeDefined()
    expect(button(renderer, 'Replace Cora with a bot')).toBeDefined()
    act(() => renderer.unmount())
  })

  it('shows local connection recovery instead of shared decision controls', () => {
    realtime.state = { ...activeState(PAUSED_PROPOSAL_FIXTURE), connectionStatus: 'disconnected' }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<RoomInterruptionDialog snapshot={PAUSED_PROPOSAL_FIXTURE} />) })

    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain('Your connection was interrupted.')
    expect(text).not.toContain('Reject proposal')
    act(() => button(renderer, 'Reconnect').props.onClick())
    expect(realtime.resynchronize).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })
})
