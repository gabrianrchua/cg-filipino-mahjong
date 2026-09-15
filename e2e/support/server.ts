import { createBackendServer } from '../../backend/src/server.js'
import { RoomService } from '../../backend/src/room-service/index.js'

import { createCompetingClaimsHand, createNextHand } from './deterministic-game.js'

const port = Number(process.env.PORT ?? 3000)
const roomService = new RoomService({
  initializeHand: createCompetingClaimsHand,
  initializeNextHand: createNextHand,
})
const { httpServer } = createBackendServer({
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  botDecisionDelayMs: 750,
  roomService,
})

httpServer.listen(port, () => {
  console.log(`Deterministic E2E backend listening on http://localhost:${port}`)
})
