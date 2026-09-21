import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ShareRoomLink } from './ShareRoomLink.tsx'

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('share room link', () => {
  it('clears copied feedback after a few seconds', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      location: { origin: 'https://mahjong.example' },
      setTimeout,
      clearTimeout,
    })
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<ShareRoomLink roomCode="MJ2345" />) })

    await act(async () => {
      renderer.root.findByType('button').props.onClick()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('https://mahjong.example/room/MJ2345')
    expect(renderer.root.findByProps({ role: 'status' }).children.join('')).toBe('Room link copied.')

    act(() => { vi.advanceTimersByTime(3_000) })
    expect(renderer.root.findByProps({ role: 'status' }).children).toHaveLength(0)

    act(() => renderer.unmount())
  })
})
