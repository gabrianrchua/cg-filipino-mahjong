import { CommandIdSchema } from '@cg-filipino-mahjong/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandId } from './commandId.ts'

afterEach(() => vi.unstubAllGlobals())

describe('createCommandId', () => {
  it('uses native randomUUID when available', () => {
    const randomUUID = vi.fn(() => '20000000-0000-4000-8000-000000000001')
    const getRandomValues = vi.fn()
    vi.stubGlobal('crypto', { randomUUID, getRandomValues })

    expect(createCommandId()).toBe(randomUUID.mock.results[0]?.value)
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it('creates a valid, distinct version 4 UUID when randomUUID is unavailable', () => {
    let nextByte = 0
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = nextByte++
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })

    const first = createCommandId()
    const second = createCommandId()
    expect(first).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    expect(second).not.toBe(first)
    expect(CommandIdSchema.safeParse(first).success).toBe(true)
    expect(CommandIdSchema.safeParse(second).success).toBe(true)
    expect(getRandomValues).toHaveBeenCalledTimes(2)
  })
})
