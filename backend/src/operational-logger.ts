export type OperationalLogLevel = 'info' | 'warn' | 'error'

export type OperationalLogFields = Readonly<Record<
  string,
  string | number | boolean | null | undefined
>>

export interface OperationalLogger {
  log(level: OperationalLogLevel, event: string, fields?: OperationalLogFields): void
}

export const silentOperationalLogger: OperationalLogger = Object.freeze({
  log: () => undefined,
})

export function logOperational(
  logger: OperationalLogger,
  level: OperationalLogLevel,
  event: string,
  fields?: OperationalLogFields,
): void {
  try {
    logger.log(level, event, fields)
  } catch {
    // Operational reporting must never change authoritative application behavior.
  }
}

export function createJsonLineLogger(
  write: (line: string) => void = (line) => { process.stdout.write(line) },
  now: () => Date = () => new Date(),
): OperationalLogger {
  return {
    log(level, event, fields = {}) {
      const allowedFields = Object.fromEntries(
        Object.entries(fields).filter((entry): entry is [string, string | number | boolean | null] => (
          entry[1] !== undefined
        )),
      )
      try {
        write(`${JSON.stringify({
          timestamp: now().toISOString(),
          level,
          event,
          ...allowedFields,
        })}\n`)
      } catch {
        // A failed log drain must not stop the service.
      }
    },
  }
}
