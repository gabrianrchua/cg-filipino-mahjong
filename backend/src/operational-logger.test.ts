import { expect, it } from 'vitest'

import { createJsonLineLogger, logOperational, type OperationalLogger } from './operational-logger.js'

it('writes one bounded JSON object per operational event', () => {
  const lines: string[] = []
  const logger = createJsonLineLogger(
    (line) => lines.push(line),
    () => new Date('2026-09-15T12:00:00.000Z'),
  )

  logger.log('warn', 'command.rejected', {
    commandType: 'room.join',
    errorCode: 'room-not-found',
    omitted: undefined,
  })

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toEqual({
    timestamp: '2026-09-15T12:00:00.000Z',
    level: 'warn',
    event: 'command.rejected',
    commandType: 'room.join',
    errorCode: 'room-not-found',
  })
  expect(lines[0]).toMatch(/\n$/u)
})

it('does not let a failed log sink affect application behavior', () => {
  const logger: OperationalLogger = { log: () => { throw new Error('drain unavailable') } }
  expect(() => logOperational(logger, 'error', 'test.failure')).not.toThrow()
})
