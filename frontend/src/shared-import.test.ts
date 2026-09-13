import {
  ACTIVE_LOCAL_TURN_FIXTURE,
  ClientCommandSchema,
  HEALTH_RESPONSE,
  type ClientToServerEvents,
  type RoomSnapshot,
} from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

describe('shared workspace import', () => {
  it('provides the public health response contract', () => {
    expect(HEALTH_RESPONSE).toEqual({ status: 'ok' })
  })

  it('provides runtime contracts and inferred client types', () => {
    const snapshot: RoomSnapshot = ACTIVE_LOCAL_TURN_FIXTURE
    const command = ClientCommandSchema.parse({
      commandId: '00000000-0000-4000-8000-000000000101',
      type: 'lobby.list',
    })
    const eventName: keyof ClientToServerEvents = 'command'

    expect(snapshot.stage).toBe('playing')
    expect(command.type).toBe('lobby.list')
    expect(eventName).toBe('command')
  })
})
