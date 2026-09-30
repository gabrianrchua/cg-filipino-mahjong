import { expect, test, type Page } from '@playwright/test'
import { HEALTH_RESPONSE } from '@cg-filipino-mahjong/shared'

async function bootstrapGuest(page: Page, displayName: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Display name').fill(displayName)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
}

test('serves health, frontend navigation, and two-browser realtime traffic from one process', async ({
  browser,
  request,
}) => {
  const health = await request.get('/api/health')
  expect(health.ok()).toBe(true)
  await expect(health.json()).resolves.toEqual(HEALTH_RESPONSE)

  const anaContext = await browser.newContext()
  const benContext = await browser.newContext()
  const ana = await anaContext.newPage()
  const ben = await benContext.newPage()
  try {
    await Promise.all([bootstrapGuest(ana, 'Ana'), bootstrapGuest(ben, 'Ben')])
    await ana.getByRole('button', { name: 'Create room' }).click()
    await expect(ana).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const roomCode = new URL(ana.url()).pathname.split('/').at(-1)!

    await ben.goto(`/room/${roomCode}`)
    await expect(ben.getByRole('heading', { name: 'Choose how to enter.' })).toBeVisible()
    await ben.getByRole('button', { name: 'Join an open seat' }).click()
    await expect(ben.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
    await expect(ana.getByRole('heading', { name: 'Ben', exact: true })).toBeVisible()

    await ben.reload()
    await expect(ben.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
  } finally {
    await Promise.all([anaContext.close(), benContext.close()])
  }
})

test('accepts a guest name when randomUUID is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined })
  })
  await bootstrapGuest(page, 'HTTP guest')
})
