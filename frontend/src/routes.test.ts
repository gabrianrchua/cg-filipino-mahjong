import { describe, expect, it } from 'vitest'

import { parseRoomCodeRoute } from './routes.ts'

describe('room-code routes', () => {
  it('normalizes valid room codes with the shared contract', () => {
    expect(parseRoomCodeRoute('mj2345')).toEqual({ ok: true, roomCode: 'MJ2345' })
  })

  it.each(['', 'ABC', 'O0I1AA', 'ABC23!'])('rejects an invalid route: %s', (value) => {
    expect(parseRoomCodeRoute(value)).toEqual({ ok: false })
  })
})
