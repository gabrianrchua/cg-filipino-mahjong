import { ACTIVE_LOCAL_TURN_FIXTURE, MASKED_SECRET_OWNER_FIXTURE, RoomSnapshotSchema } from '@cg-filipino-mahjong/shared'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_REALTIME_STATE, type RealtimeState } from '../realtime/state.ts'
import { TableScreen } from './TableScreen.tsx'
import {
  createClaimChoicesFixture,
  createSpecialActionsFixture,
  createTableLayoutFixture,
} from './tableFixture.ts'

const TABLE_LAYOUT_FIXTURE = createTableLayoutFixture()

const realtime = vi.hoisted(() => ({
  state: null as RealtimeState | null,
  actions: {
    selectTile: vi.fn(),
    setTileOrder: vi.fn(),
    submitGameplayChoice: vi.fn(),
  },
}))

vi.mock('../realtime/RealtimeProvider.tsx', () => ({
  useRealtimeState: () => realtime.state,
  useRealtimeActions: () => realtime.actions,
}))

function renderScreen(previewSnapshot = TABLE_LAYOUT_FIXTURE): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      <MemoryRouter initialEntries={['/room/MJ2345?preview=table']}>
        <TableScreen roomCode="MJ2345" previewSnapshot={previewSnapshot} />
      </MemoryRouter>,
    )
  })
  return renderer
}

function renderLive(snapshot: ReturnType<typeof createClaimChoicesFixture>, stateOverrides: Partial<RealtimeState> = {}): ReactTestRenderer {
  realtime.state = {
    ...INITIAL_REALTIME_STATE,
    connectionStatus: 'connected',
    sessionStatus: 'ready',
    sessionId: '30000000-0000-4000-8000-000000000001',
    roomSnapshot: snapshot,
    localHand: {
      identity: `${snapshot.roomId}:${snapshot.handId}:${snapshot.privateState!.seat}`,
      tileOrder: snapshot.privateState!.concealedTiles.map((tile) => tile.tileId),
      selectedTileId: null,
    },
    ...stateOverrides,
  }
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<MemoryRouter><TableScreen roomCode="MJ2345" /></MemoryRouter>) })
  return renderer
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  realtime.state = INITIAL_REALTIME_STATE
  vi.clearAllMocks()
})

describe('table screen', () => {
  it('renders the complete player-visible stress fixture without duplicating the pending discard', () => {
    const renderer = renderScreen()
    const serialized = JSON.stringify(renderer.toJSON())

    expect(serialized).toContain('Alexandria-Mari Santos')
    expect(serialized).toContain('Open káng')
    expect(serialized).toContain('Sagása')
    expect(serialized).toContain('Flowers')
    expect(serialized).toContain('42')
    expect(renderer.root.findAllByProps({ 'data-tile-id': 'preview-latest-discard' })).toHaveLength(1)
    expect(renderer.root.findByProps({ 'data-tile-id': 'preview-latest-discard' }).props['aria-label'])
      .toBe('Nine of characters, latest discard')
    expect(renderer.root.findByProps({ 'data-tile-id': 'preview-hand-16' }).props['aria-label'])
      .toContain('drawn tile')

    act(() => renderer.unmount())
  })

  it('masks opponent secrets and publishes response completion without response contents', () => {
    const renderer = renderScreen()
    const masked = renderer.root.findByProps({ 'aria-label': 'Secret meld, four concealed tiles' })
    const serialized = JSON.stringify(renderer.toJSON())

    expect(masked.findAllByType('svg')).toHaveLength(4)
    expect(serialized).toContain('2 of 3 opponents responded')
    expect(serialized).not.toMatch(/chosenTiles|concealedTileIds|legalChoices/u)
    expect(renderer.root.findAll((node) => node.props['data-tile-id']?.startsWith('preview-secret-local-'))).toHaveLength(4)

    act(() => renderer.unmount())
  })

  it('keeps counterclockwise seat orientation relative to a different local seat', () => {
    if (MASKED_SECRET_OWNER_FIXTURE.stage !== 'playing') throw new Error('Expected an active fixture')
    const renderer = renderScreen(MASKED_SECRET_OWNER_FIXTURE)

    expect(renderer.root.findByProps({ 'data-seat-position': 'local' }).props['data-seat']).toBe(1)
    expect(renderer.root.findByProps({ 'data-seat-position': 'next' }).props['data-seat']).toBe(2)
    expect(renderer.root.findByProps({ 'data-seat-position': 'across' }).props['data-seat']).toBe(3)
    expect(renderer.root.findByProps({ 'data-seat-position': 'previous' }).props['data-seat']).toBe(0)

    act(() => renderer.unmount())
  })

  it('uses the local physical-tile order maintained outside the authoritative snapshot', () => {
    const reversed = TABLE_LAYOUT_FIXTURE.privateState!.concealedTiles.map((tile) => tile.tileId).reverse()
    realtime.state = {
      ...INITIAL_REALTIME_STATE,
      connectionStatus: 'connected',
      sessionStatus: 'ready',
      roomSnapshot: TABLE_LAYOUT_FIXTURE,
      localHand: { identity: 'preview', tileOrder: reversed, selectedTileId: null },
    }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(<MemoryRouter><TableScreen roomCode="MJ2345" /></MemoryRouter>)
    })
    const rack = renderer.root.findByProps({ 'data-testid': 'tile-rack' })
    const renderedIds = rack.findAll((node) => Boolean(node.props['data-tile-id'])).map((node) => node.props['data-tile-id'])

    expect(renderedIds).toEqual(reversed)
    expect(new Set(renderedIds).size).toBe(renderedIds.length)

    act(() => renderer.unmount())
  })

  it('keeps selection separate from explicit discard and suppresses duplicate submissions', () => {
    if (ACTIVE_LOCAL_TURN_FIXTURE.stage !== 'playing') throw new Error('Expected an active fixture')
    const choice = ACTIVE_LOCAL_TURN_FIXTURE.privateState!.legalChoices[0]!
    if (choice.kind !== 'discard') throw new Error('Expected a discard choice')
    const order = ACTIVE_LOCAL_TURN_FIXTURE.privateState!.concealedTiles.map((tile) => tile.tileId)
    realtime.state = {
      ...INITIAL_REALTIME_STATE,
      connectionStatus: 'connected',
      sessionStatus: 'ready',
      sessionId: '30000000-0000-4000-8000-000000000001',
      roomSnapshot: ACTIVE_LOCAL_TURN_FIXTURE,
      localHand: {
        identity: `${ACTIVE_LOCAL_TURN_FIXTURE.roomId}:${ACTIVE_LOCAL_TURN_FIXTURE.handId}:0`,
        tileOrder: order,
        selectedTileId: choice.tileId,
      },
    }
    realtime.actions.submitGameplayChoice.mockReturnValue(new Promise(() => undefined))

    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<MemoryRouter><TableScreen roomCode="MJ2345" /></MemoryRouter>) })
    const selectedTile = renderer.root.findByProps({ 'aria-label': 'Deselect One of sticks' })
    const discard = renderer.root.find((node) => (
      node.type === 'button' && node.children.includes('Discard selected tile')
    ))
    const moveRight = renderer.root.find((node) => node.type === 'button' && node.children.includes('Move right'))

    act(() => selectedTile.props.onClick())
    expect(realtime.actions.selectTile).toHaveBeenCalledWith(null)
    act(() => moveRight.props.onClick())
    expect(realtime.actions.setTileOrder).toHaveBeenCalledWith([order[1], order[0], order[2]])
    act(() => {
      discard.props.onClick()
      discard.props.onClick()
    })
    expect(realtime.actions.submitGameplayChoice).toHaveBeenCalledTimes(1)
    expect(realtime.actions.submitGameplayChoice).toHaveBeenCalledWith(choice.choiceId)

    act(() => renderer.unmount())
  })

  it('shows every server-supplied claim combination and keeps pass available', () => {
    const renderer = renderScreen(createClaimChoicesFixture())
    const serialized = JSON.stringify(renderer.toJSON())

    expect(serialized).toContain('Win')
    const choiceHeadings = renderer.root.findAllByType('strong').map((heading) => heading.children.join(''))
    expect(choiceHeadings).toContain('Chow · option 1')
    expect(choiceHeadings).toContain('Chow · option 2')
    expect(serialized).toContain('Pong')
    expect(serialized).toContain('Open káng')
    expect(serialized).toContain('Pass')
    expect(serialized).toContain('Wins resolve first, then pong or open káng, then chow.')
    expect(renderer.root.findAllByProps({ 'data-tile-id': 'claim-latest-characters-8' }).length).toBeGreaterThan(1)

    act(() => renderer.unmount())
  })

  it('renders a usable Pass-only response instead of silently waiting', () => {
    const claim = createClaimChoicesFixture()
    const passOnly = RoomSnapshotSchema.parse({
      ...claim,
      privateState: {
        ...claim.privateState!,
        legalChoices: claim.privateState!.legalChoices.filter((choice) => choice.kind === 'pass'),
      },
    })
    if (passOnly.stage !== 'playing') throw new Error('Expected an active fixture')
    const renderer = renderScreen(passOnly)

    expect(renderer.root.findAllByType('input')).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).toContain('Decline this discard.')

    act(() => renderer.unmount())
  })

  it('previews secret, sagása, and self-draw win requirements without auto-submitting', () => {
    const renderer = renderScreen(createSpecialActionsFixture())
    const serialized = JSON.stringify(renderer.toJSON())

    expect(serialized).toContain('Declare a win using your current draw.')
    expect(serialized).toContain('Conceal four matching tiles')
    expect(serialized).toContain('Upgrade this open pong with the tile you just drew')
    expect(renderer.root.findAllByProps({ 'data-tile-id': 'special-balls-5-drawn' }).length).toBeGreaterThan(1)
    expect(realtime.actions.submitGameplayChoice).not.toHaveBeenCalled()

    act(() => renderer.unmount())
  })

  it('locks an acknowledged response and reports only generic waiting progress', async () => {
    const claim = createClaimChoicesFixture()
    realtime.actions.submitGameplayChoice.mockResolvedValue({
      commandId: '30000000-0000-4000-8000-000000000002',
      status: 'accepted',
      duplicate: false,
      result: { kind: 'completed' },
    })
    const renderer = renderLive(claim)
    const passIndex = claim.privateState!.legalChoices.findIndex((choice) => choice.kind === 'pass')
    const radio = renderer.root.findAllByType('input')[passIndex]!

    act(() => radio.props.onChange())
    const submit = renderer.root.find((node) => node.type === 'button' && node.children.includes('Submit pass'))
    await act(async () => { submit.props.onClick(); await Promise.resolve() })

    const serialized = JSON.stringify(renderer.toJSON())
    expect(realtime.actions.submitGameplayChoice).toHaveBeenCalledTimes(1)
    expect(serialized).toContain('Response received. Waiting for the other opponents.')
    expect(serialized).not.toContain('Submit pass')

    act(() => renderer.unmount())
  })

  it('surfaces a rejected stale response and leaves refreshed choices selectable', async () => {
    const claim = createClaimChoicesFixture()
    realtime.actions.submitGameplayChoice.mockResolvedValue({
      commandId: '30000000-0000-4000-8000-000000000003',
      status: 'rejected',
      duplicate: false,
      error: { code: 'stale-phase', message: 'The action phase has changed.' },
      snapshot: claim,
    })
    const renderer = renderLive(claim)
    const radio = renderer.root.findAllByType('input')[0]!

    act(() => radio.props.onChange())
    const submit = renderer.root.find((node) => node.type === 'button' && node.children.includes('Declare win'))
    await act(async () => { submit.props.onClick(); await Promise.resolve() })

    expect(renderer.root.findByProps({ role: 'alert' }).children).toContain('The action phase has changed.')
    expect(renderer.root.findAllByType('input').some((input) => !input.props.disabled)).toBe(true)

    act(() => renderer.unmount())
  })

  it('disables response changes while the phase command is awaiting acknowledgement', () => {
    const claim = createClaimChoicesFixture()
    const renderer = renderLive(claim, {
      pendingCommands: {
        pending: {
          commandId: '30000000-0000-4000-8000-000000000004',
          type: 'game.action',
          startedAt: 1,
          roomId: claim.roomId,
          handId: claim.handId,
          phaseId: claim.phase.phaseId,
        },
      },
    })

    expect(renderer.root.findByType('fieldset').props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain('Sending your choice…')

    act(() => renderer.unmount())
  })
})
