import {
  ClientCommandSchema,
  CommandAcknowledgementSchema,
  type ClientCommand,
  type ServerToClientEvents,
} from '@cg-filipino-mahjong/shared'
import { describe, expect, it } from 'vitest'

describe('shared backend contract imports', () => {
  it('parses untrusted commands before orchestration', () => {
    const command: ClientCommand = ClientCommandSchema.parse({
      commandId: '00000000-0000-4000-8000-000000000201',
      type: 'room.join',
      roomCode: ' mj2345 ',
    })
    if (command.type !== 'room.join') throw new Error('Expected room.join command')
    expect(command.roomCode).toBe('MJ2345')
  })

  it('provides server event and acknowledgement types', () => {
    const eventName: keyof ServerToClientEvents = 'room.snapshot'
    const acknowledgement = CommandAcknowledgementSchema.parse({
      commandId: '00000000-0000-4000-8000-000000000201',
      status: 'accepted',
      duplicate: false,
      result: { kind: 'completed' },
    })

    expect(eventName).toBe('room.snapshot')
    expect(acknowledgement.status).toBe('accepted')
  })
})
