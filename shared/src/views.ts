import { z } from 'zod'

import {
  ChoiceIdSchema,
  DisplayNameSchema,
  FlowerTileSchema,
  HandIdSchema,
  MeldIdSchema,
  PhaseIdSchema,
  ProposalIdSchema,
  RankSchema,
  ReadinessIdSchema,
  RevisionSchema,
  RoomCodeSchema,
  RoomIdSchema,
  SeatSchema,
  SuitedTileSchema,
  SuitSchema,
  TakeoverIdSchema,
  TileIdSchema,
  VisibilitySchema,
} from './primitives.js'

export const LobbyRoomStatusSchema = z.enum(['waiting', 'playing', 'between-hands'])

export const LobbySummarySchema = z.strictObject({
  roomId: RoomIdSchema,
  roomCode: RoomCodeSchema,
  visibility: z.literal('public'),
  status: LobbyRoomStatusSchema,
  isPaused: z.boolean(),
  humanCount: z.number().int().min(0).max(4),
  availableSeatCount: z.number().int().min(0).max(4),
  takeoverSeatCount: z.number().int().min(0).max(4),
  spectatorCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})

export const RoomEntrySeatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ seat: SeatSchema, kind: z.literal('available') }),
  z.strictObject({ seat: SeatSchema, kind: z.literal('bot'), takeoverAvailable: z.boolean() }),
  z.strictObject({
    seat: SeatSchema,
    kind: z.literal('human'),
    displayName: DisplayNameSchema,
    connection: z.enum(['connected', 'disconnected']),
  }),
])

export const RoomEntrySummarySchema = z.strictObject({
  roomCode: RoomCodeSchema,
  status: LobbyRoomStatusSchema,
  isPaused: z.boolean(),
  humanCount: z.number().int().min(0).max(4),
  availableSeatCount: z.number().int().min(0).max(4),
  takeoverSeats: z.array(SeatSchema).max(4),
  spectatorCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  seats: z.array(RoomEntrySeatSchema).length(4),
})

const ThreeTileOpenMeldSchema = z.strictObject({
  meldId: MeldIdSchema,
  kind: z.enum(['chow', 'pong']),
  tiles: z.array(SuitedTileSchema).length(3),
})

const FourTileOpenMeldSchema = z.strictObject({
  meldId: MeldIdSchema,
  kind: z.enum(['open-kang', 'sagasa']),
  tiles: z.array(SuitedTileSchema).length(4),
})

const RevealedSecretMeldSchema = z.strictObject({
  meldId: MeldIdSchema,
  kind: z.literal('secret'),
  visibility: z.literal('owner'),
  tiles: z.array(SuitedTileSchema).length(4),
})

const MaskedSecretMeldSchema = z.strictObject({
  meldId: MeldIdSchema,
  kind: z.literal('secret'),
  visibility: z.literal('masked'),
  tileCount: z.literal(4),
})

export const PlayerVisibleMeldSchema = z.union([
  ThreeTileOpenMeldSchema,
  FourTileOpenMeldSchema,
  RevealedSecretMeldSchema,
  MaskedSecretMeldSchema,
])

export const SeatControllerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({ kind: z.literal('bot') }),
  z.strictObject({
    kind: z.literal('human'),
    displayName: DisplayNameSchema,
    connection: z.enum(['connected', 'disconnected']),
    ready: z.boolean(),
  }),
])

export const SeatViewSchema = z.strictObject({
  seat: SeatSchema,
  isDealer: z.boolean(),
  controller: SeatControllerSchema,
  concealedCount: z.number().int().nonnegative().max(17),
  melds: z.array(PlayerVisibleMeldSchema).max(5),
  flowers: z.array(FlowerTileSchema).max(36),
})

const DiscardChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.literal('discard'),
  tileId: TileIdSchema,
})

const WinChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.literal('win'),
  source: z.enum(['self-draw', 'discard']),
})

const SecretChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.literal('secret'),
  concealedTileIds: z.array(TileIdSchema).length(4),
})

const SagasaChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.literal('sagasa'),
  meldId: MeldIdSchema,
  tileId: TileIdSchema,
})

const PassChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.literal('pass'),
})

const ChowOrPongChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.enum(['chow', 'pong']),
  concealedTileIds: z.array(TileIdSchema).length(2),
})

const OpenKangChoiceSchema = z.strictObject({
  choiceId: ChoiceIdSchema,
  kind: z.literal('open-kang'),
  concealedTileIds: z.array(TileIdSchema).length(3),
})

export const LegalChoiceSchema = z.union([
  DiscardChoiceSchema,
  WinChoiceSchema,
  SecretChoiceSchema,
  SagasaChoiceSchema,
  PassChoiceSchema,
  ChowOrPongChoiceSchema,
  OpenKangChoiceSchema,
])

export const RecipientPrivateStateSchema = z.strictObject({
  seat: SeatSchema,
  concealedTiles: z.array(SuitedTileSchema).max(17),
  drawnTileId: TileIdSchema.nullable(),
  legalChoices: z.array(LegalChoiceSchema).max(80),
  hasResponded: z.boolean(),
})

export const ProposalSchema = z.strictObject({
  proposalId: ProposalIdSchema,
  kind: z.enum(['abort-hand', 'replace-with-bot']),
  proposedBy: SeatSchema,
  targetSeat: SeatSchema.nullable(),
  votes: z.array(z.strictObject({
    seat: SeatSchema,
    status: z.enum(['approved', 'pending']),
  })).max(4),
})

export const TakeoverReservationSchema = z.strictObject({
  takeoverId: TakeoverIdSchema,
  seat: SeatSchema,
  status: z.literal('pending-phase-resolution'),
  isMine: z.boolean(),
})

export const PauseStateSchema = z.strictObject({
  isPaused: z.boolean(),
  disconnectedSeats: z.array(SeatSchema).max(4),
})

export const RecipientControlSchema = z.strictObject({
  role: z.enum(['player', 'spectator', 'pending-takeover']),
  seat: SeatSchema.nullable(),
  canControl: z.boolean(),
}).superRefine((self, context) => {
  const isPlayer = self.role === 'player'
  if (isPlayer !== (self.seat !== null) || isPlayer !== self.canControl) {
    context.addIssue({ code: 'custom', message: 'Recipient role, seat, and control permission must agree.' })
  }
})

const SnapshotBaseSchema = z.strictObject({
  roomId: RoomIdSchema,
  roomCode: RoomCodeSchema,
  roomRevision: RevisionSchema,
  visibility: VisibilitySchema,
  readinessId: ReadinessIdSchema,
  spectatorCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  self: RecipientControlSchema,
  seats: z.array(SeatViewSchema).length(4),
  discards: z.array(SuitedTileSchema).max(108),
  pause: PauseStateSchema,
  proposal: ProposalSchema.nullable(),
  takeoverReservations: z.array(TakeoverReservationSchema).max(4),
})

type PrivacySnapshot = z.infer<typeof SnapshotBaseSchema> & {
  privateState?: z.infer<typeof RecipientPrivateStateSchema> | null
}

const validateRecipientPrivacy = (snapshot: PrivacySnapshot, context: z.RefinementCtx) => {
  if (snapshot.self.role !== 'player' && snapshot.privateState !== undefined && snapshot.privateState !== null) {
    context.addIssue({
      code: 'custom',
      path: ['privateState'],
      message: 'A non-player recipient cannot receive private state',
    })
  }
  if (snapshot.privateState && snapshot.privateState.seat !== snapshot.self.seat) {
    context.addIssue({
      code: 'custom',
      path: ['privateState', 'seat'],
      message: 'Private state must belong to the controlling recipient seat',
    })
  }

  snapshot.seats.forEach((seat, seatIndex) => {
    seat.melds.forEach((meld, meldIndex) => {
      if (meld.kind !== 'secret') return
      const expectedVisibility = seat.seat === snapshot.self.seat ? 'owner' : 'masked'
      if (meld.visibility !== expectedVisibility) {
        context.addIssue({
          code: 'custom',
          path: ['seats', seatIndex, 'melds', meldIndex, 'visibility'],
          message: `Secret meld must use ${expectedVisibility} visibility for this recipient`,
        })
      }
    })
  })
}

export const SetupPhaseSchema = z.strictObject({
  phaseId: PhaseIdSchema,
  kind: z.literal('setup'),
})

export const PlayerActionPhaseSchema = z.strictObject({
  phaseId: PhaseIdSchema,
  kind: z.literal('player-action'),
  actingSeat: SeatSchema,
})

export const DiscardResponsesPhaseSchema = z.strictObject({
  phaseId: PhaseIdSchema,
  kind: z.literal('discard-responses'),
  discarderSeat: SeatSchema,
  latestDiscard: SuitedTileSchema,
  respondedSeats: z.array(SeatSchema).max(3),
})

export const ActivePhaseSchema = z.discriminatedUnion('kind', [
  SetupPhaseSchema,
  PlayerActionPhaseSchema,
  DiscardResponsesPhaseSchema,
])

const DecompositionGroupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pair'), tiles: z.array(SuitedTileSchema).length(2) }),
  z.strictObject({ kind: z.literal('chow'), tiles: z.array(SuitedTileSchema).length(3) }),
  z.strictObject({ kind: z.literal('pong'), tiles: z.array(SuitedTileSchema).length(3) }),
  z.strictObject({ kind: z.literal('kang'), tiles: z.array(SuitedTileSchema).length(4) }),
])

export const WinningDecompositionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('regular'),
    groups: z.array(DecompositionGroupSchema).length(6),
  }),
  z.strictObject({
    kind: z.literal('seven-pairs-plus-pong'),
    groups: z.array(DecompositionGroupSchema).length(8),
  }),
])

export const HandResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('win'),
    winnerSeat: SeatSchema,
    source: z.enum(['self-draw', 'discard']),
    winningTile: SuitedTileSchema,
    decomposition: WinningDecompositionSchema,
    nextDealerSeat: SeatSchema,
  }),
  z.strictObject({
    kind: z.literal('exhaustion-draw'),
    nextDealerSeat: SeatSchema,
  }),
  z.strictObject({
    kind: z.literal('abort'),
    nextDealerSeat: SeatSchema,
  }),
])

export const WaitingRoomSnapshotSchema = SnapshotBaseSchema.extend({
  stage: z.literal('waiting'),
}).superRefine(validateRecipientPrivacy)

export const ActiveGameSnapshotSchema = SnapshotBaseSchema.extend({
  stage: z.literal('playing'),
  handId: HandIdSchema,
  gameRevision: RevisionSchema,
  wallRemainingCount: z.number().int().nonnegative().max(144),
  phase: ActivePhaseSchema,
  privateState: RecipientPrivateStateSchema.nullable(),
}).superRefine(validateRecipientPrivacy)

export const BetweenHandsSnapshotSchema = SnapshotBaseSchema.extend({
  stage: z.literal('between-hands'),
  handId: HandIdSchema,
  gameRevision: RevisionSchema,
  result: HandResultSchema,
}).superRefine(validateRecipientPrivacy)

export const RoomSnapshotSchema = z.discriminatedUnion('stage', [
  WaitingRoomSnapshotSchema,
  ActiveGameSnapshotSchema,
  BetweenHandsSnapshotSchema,
])

export const TileFaceSchema = z.strictObject({
  suit: SuitSchema,
  rank: RankSchema,
})

export type LobbySummary = z.infer<typeof LobbySummarySchema>
export type RoomEntrySummary = z.infer<typeof RoomEntrySummarySchema>
export type RoomEntrySeat = z.infer<typeof RoomEntrySeatSchema>
export type PlayerVisibleMeld = z.infer<typeof PlayerVisibleMeldSchema>
export type SeatController = z.infer<typeof SeatControllerSchema>
export type SeatView = z.infer<typeof SeatViewSchema>
export type LegalChoice = z.infer<typeof LegalChoiceSchema>
export type RecipientPrivateState = z.infer<typeof RecipientPrivateStateSchema>
export type Proposal = z.infer<typeof ProposalSchema>
export type ActivePhase = z.infer<typeof ActivePhaseSchema>
export type WinningDecomposition = z.infer<typeof WinningDecompositionSchema>
export type HandResult = z.infer<typeof HandResultSchema>
export type WaitingRoomSnapshot = z.infer<typeof WaitingRoomSnapshotSchema>
export type ActiveGameSnapshot = z.infer<typeof ActiveGameSnapshotSchema>
export type BetweenHandsSnapshot = z.infer<typeof BetweenHandsSnapshotSchema>
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>
