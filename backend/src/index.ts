import {
  createBackendServer,
} from './server.js'

const port = Number(process.env.PORT ?? 3000)
const { httpServer } = createBackendServer({
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
})

httpServer.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`)
})
