import { ACTIVE_LOCAL_TURN_FIXTURE, MASKED_SECRET_OWNER_FIXTURE } from '@cg-filipino-mahjong/shared'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_REALTIME_STATE, type RealtimeState } from '../realtime/state.ts'
import { TableScreen } from './TableScreen.tsx'
import { createTableLayoutFixture } from './tableFixture.ts'

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
})
