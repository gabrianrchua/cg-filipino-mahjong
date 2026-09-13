export const HEALTH_RESPONSE = Object.freeze({ status: 'ok' } as const)

export type HealthResponse = typeof HEALTH_RESPONSE
