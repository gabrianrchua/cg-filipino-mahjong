import { HEALTH_RESPONSE } from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

describe('shared workspace import', () => {
  it('provides the public health response contract', () => {
    expect(HEALTH_RESPONSE).toEqual({ status: 'ok' })
  })
})
