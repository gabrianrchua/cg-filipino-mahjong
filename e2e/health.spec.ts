import { HEALTH_RESPONSE } from '@cg-filipino-mahjong/shared'
import { expect, test } from '@playwright/test'

test('starts the application and exposes backend health', async ({
  page,
  request,
}) => {
  const healthResponse = await request.get('/api/health')

  expect(healthResponse.ok()).toBe(true)
  await expect(healthResponse.json()).resolves.toEqual(HEALTH_RESPONSE)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Mahjong, made for the whole table.' })).toBeVisible()
})
