import { RoomSnapshotSchema, type ActiveGameSnapshot } from '@cg-filipino-mahjong/shared'
import { useState } from 'react'

import { Button } from '../components/Button.tsx'
import { TableScreen } from './TableScreen.tsx'
import { createDenseMeldsFixture, createTableLayoutFixture } from './tableFixture.ts'

type MotionKind = 'draw' | 'discard' | 'meld' | 'dense-meld'

function playing(value: unknown): ActiveGameSnapshot {
  const parsed = RoomSnapshotSchema.parse(value)
  if (parsed.stage !== 'playing') throw new Error('Expected playing preview')
  return parsed
}

function snapshots(kind: MotionKind): readonly ActiveGameSnapshot[] {
  if (kind === 'dense-meld') {
    const after = createDenseMeldsFixture()
    return [playing({
      ...after, roomRevision: after.roomRevision - 1, gameRevision: after.gameRevision - 1,
      seats: after.seats.map((seat) => seat.seat === 1 ? { ...seat, melds: seat.melds.slice(0, 4) } : seat),
    }), after, playing({ ...after, handId: '00000000-0000-4000-8000-000000001600' })]
  }
  const base = createTableLayoutFixture()
  const local = base.seats[0]!
  const discarder = base.seats[3]!
  const privateState = base.privateState!
  const last = privateState.concealedTiles.at(-1)!
  const previousRevision = { roomRevision: base.roomRevision - 1, gameRevision: base.gameRevision - 1 }

  if (kind === 'draw') {
    return [playing({
      ...base, ...previousRevision,
      seats: base.seats.map((seat) => seat.seat === 0 ? { ...seat, concealedCount: 16 } : seat),
      privateState: { ...privateState, concealedTiles: privateState.concealedTiles.slice(0, -1), drawnTileId: null },
    }), playing({
      ...base, phase: { kind: 'player-action', phaseId: '00000000-0000-4000-8000-000000000582', actingSeat: 0 },
    })]
  }

  if (kind === 'discard') {
    const initial = playing({
      ...base, ...previousRevision,
      phase: { kind: 'player-action', phaseId: '00000000-0000-4000-8000-000000000583', actingSeat: 0 },
      seats: base.seats.map((seat) => seat.seat === 3
        ? { ...seat, discards: discarder.discards.slice(0, -1) }
        : seat),
    })
    return [initial, playing({
      ...base,
      phase: { kind: 'discard-responses', phaseId: '00000000-0000-4000-8000-000000000584', discarderSeat: 0, latestDiscard: last, respondedSeats: [] },
      seats: base.seats.map((seat) => seat.seat === 0
        ? { ...seat, concealedCount: 16, discards: [...local.discards, last] }
        : seat.seat === 3 ? { ...seat, discards: discarder.discards.slice(0, -1) } : seat),
      privateState: { ...privateState, concealedTiles: privateState.concealedTiles.slice(0, -1), drawnTileId: null },
    })]
  }

  const selected = [
    { tileId: 'preview-motion-chow-7', kind: 'suited', suit: 'characters', rank: 7 },
    { tileId: 'preview-motion-chow-8', kind: 'suited', suit: 'characters', rank: 8 },
  ]
  const beforeHand = [...privateState.concealedTiles.slice(0, 14), ...selected]
  const meld = {
    meldId: '00000000-0000-4000-8000-000000000585', kind: 'chow',
    tiles: [...selected, base.phase.kind === 'discard-responses' ? base.phase.latestDiscard : last],
  }
  return [playing({
    ...base, ...previousRevision,
    seats: base.seats.map((seat) => seat.seat === 0 ? { ...seat, concealedCount: 16 } : seat),
    privateState: { ...privateState, concealedTiles: beforeHand, drawnTileId: null },
  }), playing({
    ...base,
    phase: { kind: 'player-action', phaseId: '00000000-0000-4000-8000-000000000586', actingSeat: 0 },
    seats: base.seats.map((seat) => seat.seat === 0
      ? { ...seat, concealedCount: 14, melds: [...local.melds, meld] }
      : seat.seat === 3 ? { ...seat, discards: discarder.discards.slice(0, -1) } : seat),
    privateState: { ...privateState, concealedTiles: privateState.concealedTiles.slice(0, 14), drawnTileId: null },
  })]
}

export function MotionPreview({ kind, roomCode }: { readonly kind: MotionKind; readonly roomCode: string }) {
  const [pair] = useState(() => snapshots(kind))
  const [step, setStep] = useState(0)
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Button onClick={() => setStep((current) => current + 1)} disabled={step === pair.length - 1}>
        {kind === 'dense-meld' && step === 1 ? 'Reset hand preview' : `Advance ${kind} preview`}
      </Button>
      <TableScreen roomCode={roomCode} previewSnapshot={pair[step]!} animatePreview />
    </div>
  )
}
