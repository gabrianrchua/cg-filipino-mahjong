import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'

import { AppShell } from './components/AppShell.tsx'
import { LobbyScreen } from './screens/LobbyScreen.tsx'
import { NotFoundScreen } from './screens/NotFoundScreen.tsx'
import { TableScreen } from './screens/TableScreen.tsx'
import { WaitingRoomScreen } from './screens/WaitingRoomScreen.tsx'
import { RoomEntryScreen } from './screens/RoomEntryScreen.tsx'
import { useRealtimeState } from './realtime/RealtimeProvider.tsx'
import { parseRoomCodeRoute } from './routes.ts'

function RoomRoute() {
  const { roomCode = '' } = useParams()
  const location = useLocation()
  const parsedRoomCode = parseRoomCodeRoute(roomCode)
  const { roomSnapshot } = useRealtimeState()

  if (!parsedRoomCode.ok) return <NotFoundScreen roomCode={roomCode} />
  if (roomCode !== parsedRoomCode.roomCode) {
    return <Navigate replace to={`/room/${parsedRoomCode.roomCode}${location.search}`} />
  }

  const preview = import.meta.env.DEV
    ? new URLSearchParams(location.search).get('preview')
    : null
  if (preview === 'table') return <TableScreen roomCode={parsedRoomCode.roomCode} />
  if (roomSnapshot && roomSnapshot.roomCode !== parsedRoomCode.roomCode) {
    return <Navigate replace to={`/room/${roomSnapshot.roomCode}`} />
  }
  if (!roomSnapshot?.self.canControl) return <RoomEntryScreen roomCode={parsedRoomCode.roomCode} />
  return roomSnapshot.stage === 'playing'
    ? <TableScreen roomCode={parsedRoomCode.roomCode} />
    : <WaitingRoomScreen roomCode={parsedRoomCode.roomCode} />
}

function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<LobbyScreen />} />
        <Route path="/room/:roomCode" element={<RoomRoute />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Routes>
    </AppShell>
  )
}

export default App
