import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'

import { AppShell } from './components/AppShell.tsx'
import { RoomInterruptionDialog } from './components/RoomInterruptionDialog.tsx'
import { LobbyScreen } from './screens/LobbyScreen.tsx'
import { NotFoundScreen } from './screens/NotFoundScreen.tsx'
import { TableScreen } from './screens/TableScreen.tsx'
import { MotionPreview } from './screens/MotionPreview.tsx'
import {
  createClaimChoicesFixture,
  createDenseMeldsFixture,
  createHandArrangementFixture,
  createSpecialActionsFixture,
  createSpectatorTableFixture,
  createTableLayoutFixture,
} from './screens/tableFixture.ts'
import { WaitingRoomScreen } from './screens/WaitingRoomScreen.tsx'
import { RoomEntryScreen } from './screens/RoomEntryScreen.tsx'
import { useRealtimeState } from './realtime/RealtimeProvider.tsx'
import { parseRoomCodeRoute } from './routes.ts'

function RoomRoute() {
  const { roomCode = '' } = useParams()
  const location = useLocation()
  const parsedRoomCode = parseRoomCodeRoute(roomCode)
  const { departure, roomSnapshot } = useRealtimeState()

  if (!parsedRoomCode.ok) return <AppShell><NotFoundScreen roomCode={roomCode} /></AppShell>
  if (roomCode !== parsedRoomCode.roomCode) {
    return <Navigate replace to={`/room/${parsedRoomCode.roomCode}${location.search}`} />
  }
  if (departure?.status === 'detached' && departure.roomCode === parsedRoomCode.roomCode) {
    return <Navigate replace to="/" />
  }

  const preview = import.meta.env.DEV
    ? new URLSearchParams(location.search).get('preview')
    : null
  const play = (screen: ReactNode) => <AppShell roomCode={parsedRoomCode.roomCode} playRoomCode={parsedRoomCode.roomCode}>{screen}</AppShell>
  if (preview === 'melds') return play(<TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={createDenseMeldsFixture()} />)
  if (preview === 'table') return play(<TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={createTableLayoutFixture()} />)
  if (preview === 'hand-6' || preview === 'hand-7' || preview === 'hand-9' || preview === 'hand-10' || preview === 'hand-14' || preview === 'hand-15' || preview === 'hand-16') return play(<TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={createHandArrangementFixture(Number(preview.slice(5)))} />)
  if (preview === 'arrangement') return play(<TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={createHandArrangementFixture()} />)
  if (preview === 'claims') return play(<TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={createClaimChoicesFixture()} />)
  if (preview === 'special') return play(<TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={createSpecialActionsFixture()} />)
  if (preview === 'spectator') {
    const spectatorPreview = createSpectatorTableFixture()
    return (
      <AppShell
        roomCode={parsedRoomCode.roomCode}
        spectatorCount={spectatorPreview.spectatorCount}
        playRoomCode={parsedRoomCode.roomCode}
      >
        <TableScreen roomCode={parsedRoomCode.roomCode} previewSnapshot={spectatorPreview} />
      </AppShell>
    )
  }
  if (preview === 'motion-draw' || preview === 'motion-discard' || preview === 'motion-meld' || preview === 'motion-dense-meld' || preview === 'motion-pile') {
    return play(<MotionPreview key={preview} roomCode={parsedRoomCode.roomCode} kind={preview.slice(7) as 'draw' | 'discard' | 'meld' | 'dense-meld' | 'pile'} />)
  }
  if (roomSnapshot && roomSnapshot.roomCode !== parsedRoomCode.roomCode) {
    return <Navigate replace to={`/room/${roomSnapshot.roomCode}`} />
  }
  if (!roomSnapshot || roomSnapshot.roomCode !== parsedRoomCode.roomCode || roomSnapshot.self.role === 'pending-takeover') {
    return <AppShell><RoomEntryScreen key={parsedRoomCode.roomCode} roomCode={parsedRoomCode.roomCode} /></AppShell>
  }
  return (
    <AppShell
      roomCode={parsedRoomCode.roomCode}
      spectatorCount={roomSnapshot.spectatorCount}
      playRoomCode={roomSnapshot.stage === 'playing' ? parsedRoomCode.roomCode : undefined}
    >
      {roomSnapshot.stage === 'playing'
        ? <TableScreen roomCode={parsedRoomCode.roomCode} />
        : <WaitingRoomScreen roomCode={parsedRoomCode.roomCode} />}
      <RoomInterruptionDialog snapshot={roomSnapshot} />
    </AppShell>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell><LobbyScreen /></AppShell>} />
      <Route path="/room/:roomCode" element={<RoomRoute />} />
      <Route path="*" element={<AppShell><NotFoundScreen /></AppShell>} />
    </Routes>
  )
}

export default App
