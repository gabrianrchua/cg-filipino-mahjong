import {
  HEALTH_RESPONSE,
  type HealthResponse,
} from '@cg-filipino-mahjong/shared'
import express from 'express'

const app = express()
const port = Number(process.env.PORT ?? 3000)

app.use(express.json())

app.get('/api/health', (_request, response) => {
  response.json(HEALTH_RESPONSE satisfies HealthResponse)
})

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`)
})
