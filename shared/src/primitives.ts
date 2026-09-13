import { z } from 'zod'

const uuid = () => z.string().uuid()

export const CommandIdSchema = uuid()
export const SessionIdSchema = uuid()
export const RoomIdSchema = uuid()
export const HandIdSchema = uuid()
export const PhaseIdSchema = uuid()
export const ReadinessIdSchema = uuid()
export const ProposalIdSchema = uuid()
export const ChoiceIdSchema = uuid()
export const MeldIdSchema = uuid()
export const TakeoverIdSchema = uuid()

export const RevisionSchema = z.number().int().nonnegative().safe()
export const SeatSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
])

export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)

const hasControlCharacter = (value: string) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
})

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 24, 'Must contain at most 24 Unicode characters')
  .refine((value) => !hasControlCharacter(value), 'Control characters are not allowed')

export const ReconnectCredentialSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u)

export const VisibilitySchema = z.enum(['public', 'unlisted'])
export const SuitSchema = z.enum(['sticks', 'dots', 'characters'])
export const RankSchema = z.number().int().min(1).max(9)
export const TileIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u)

export const SuitedTileSchema = z.strictObject({
  tileId: TileIdSchema,
  kind: z.literal('suited'),
  suit: SuitSchema,
  rank: RankSchema,
})

export const FlowerIdentitySchema = z.enum([
  'east-wind',
  'south-wind',
  'west-wind',
  'north-wind',
  'red-dragon',
  'green-dragon',
  'white-dragon',
  'spring',
  'summer',
  'autumn',
  'winter',
  'plum',
  'orchid',
  'chrysanthemum',
  'bamboo',
])

export const FlowerTileSchema = z.strictObject({
  tileId: TileIdSchema,
  kind: z.literal('flower'),
  identity: FlowerIdentitySchema,
})

export const PlayerSafeTileSchema = z.discriminatedUnion('kind', [
  SuitedTileSchema,
  FlowerTileSchema,
])

export type CommandId = z.infer<typeof CommandIdSchema>
export type SessionId = z.infer<typeof SessionIdSchema>
export type RoomId = z.infer<typeof RoomIdSchema>
export type HandId = z.infer<typeof HandIdSchema>
export type PhaseId = z.infer<typeof PhaseIdSchema>
export type ReadinessId = z.infer<typeof ReadinessIdSchema>
export type ProposalId = z.infer<typeof ProposalIdSchema>
export type ChoiceId = z.infer<typeof ChoiceIdSchema>
export type MeldId = z.infer<typeof MeldIdSchema>
export type TakeoverId = z.infer<typeof TakeoverIdSchema>
export type Seat = z.infer<typeof SeatSchema>
export type Revision = z.infer<typeof RevisionSchema>
export type RoomCode = z.infer<typeof RoomCodeSchema>
export type DisplayName = z.infer<typeof DisplayNameSchema>
export type ReconnectCredential = z.infer<typeof ReconnectCredentialSchema>
export type Visibility = z.infer<typeof VisibilitySchema>
export type Suit = z.infer<typeof SuitSchema>
export type Rank = z.infer<typeof RankSchema>
export type TileId = z.infer<typeof TileIdSchema>
export type FlowerIdentity = z.infer<typeof FlowerIdentitySchema>
export type SuitedTile = z.infer<typeof SuitedTileSchema>
export type FlowerTile = z.infer<typeof FlowerTileSchema>
export type PlayerSafeTile = z.infer<typeof PlayerSafeTileSchema>
