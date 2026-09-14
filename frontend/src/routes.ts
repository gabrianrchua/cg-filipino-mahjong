import { RoomCodeSchema, type RoomCode } from '@cg-filipino-mahjong/shared'

export type ParsedRoomCode =
  | { readonly ok: true; readonly roomCode: RoomCode }
  | { readonly ok: false }

export function parseRoomCodeRoute(value: string): ParsedRoomCode {
  const result = RoomCodeSchema.safeParse(value)
  return result.success ? { ok: true, roomCode: result.data } : { ok: false }
}
