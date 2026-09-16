import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createJsonLineLogger, logOperational } from './operational-logger.js'
import {
  createBackendServer,
} from './server.js'

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }
  return port
}

function parseNonNegativeNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`)
  }
  return parsed
}

function parseCorsOrigin(value: string | undefined): string | string[] | undefined {
  const origins = value?.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (!origins?.length) return undefined
  return origins.length === 1 ? origins[0] : origins
}

const logger = createJsonLineLogger()
const port = parsePort(process.env.PORT)
const host = process.env.HOST?.trim() || '0.0.0.0'
const botDecisionDelayMs = process.env.BOT_DECISION_DELAY_MS === undefined
  ? undefined
  : parseNonNegativeNumber(process.env.BOT_DECISION_DELAY_MS, 'BOT_DECISION_DELAY_MS')
const isProduction = process.env.NODE_ENV === 'production' || import.meta.url.endsWith('/dist/index.js')
const corsOrigin = parseCorsOrigin(process.env.CORS_ORIGIN)
  ?? (isProduction ? undefined : 'http://localhost:5173')
const frontendDistPath = fileURLToPath(new URL('../../frontend/dist', import.meta.url))

if (isProduction && !existsSync(frontendDistPath)) {
  throw new Error(`Built frontend not found at ${frontendDistPath}. Run npm run build before starting.`)
}

const { httpServer, shutdown } = createBackendServer({
  corsOrigin,
  botDecisionDelayMs,
  frontendDistPath: isProduction ? frontendDistPath : undefined,
  logger,
})

httpServer.listen(port, host, () => {
  logOperational(logger, 'info', 'server.started', { host, port })
})

httpServer.on('error', () => {
  logOperational(logger, 'error', 'server.listen_failed')
  process.exitCode = 1
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logOperational(logger, 'info', 'server.signal_received', { signal })
    void shutdown().catch(() => {
      logOperational(logger, 'error', 'server.shutdown_failed')
      process.exitCode = 1
    })
  })
}
