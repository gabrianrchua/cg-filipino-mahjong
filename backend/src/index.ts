import {
  createBackendServer,
} from './server.js'

const port = Number(process.env.PORT ?? 3000)
const botDecisionDelayMs = process.env.BOT_DECISION_DELAY_MS === undefined
  ? undefined
  : Number(process.env.BOT_DECISION_DELAY_MS)
const { httpServer } = createBackendServer({
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  botDecisionDelayMs,
})

httpServer.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`)
})
