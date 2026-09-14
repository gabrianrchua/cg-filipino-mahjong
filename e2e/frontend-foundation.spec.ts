import { expect, test } from '@playwright/test'

test('navigates with a canonical room code and survives reload', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Room code').fill('mj2345')
  await page.getByRole('button', { name: 'Join room' }).click()
  await expect(page).toHaveURL(/\/room\/MJ2345$/u)
  await expect(page.getByRole('heading', { name: 'The table is almost ready.' })).toBeVisible()
  await page.reload()
  await expect(page.getByText('MJ2345')).toBeVisible()
})

test('rejects malformed direct room links', async ({ page }) => {
  await page.goto('/room/O0I1AA')
  await expect(page.getByRole('heading', { name: 'Check the room code.' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to the lobby' })).toBeVisible()
})

test('contains dialog focus and restores it to the trigger', async ({ page }) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'How to play' })
  await trigger.focus()
  await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'A quick seat at the table' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Tab')
  await expect.poll(async () => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('keeps the seventeen-tile hand readable and locally scrollable on phones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=table')
  await expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()
  const rack = page.getByTestId('tile-rack')
  await expect(rack.locator('[data-tile-number]')).toHaveCount(17)
  await expect.poll(() => rack.evaluate((element) => {
    const scrollParent = element.parentElement
    return Boolean(scrollParent && element.scrollWidth > scrollParent.clientWidth)
  })).toBe(true)
  await expect.poll(async () => (await rack.locator('[data-tile-number="1"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone landscape', width: 844, height: 390 },
]) {
  test(`lays out the table at ${viewport.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/room/MJ2345?preview=table')
    await expect(page.getByLabel('Mahjong table with four seats')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
}

test('honors reduced-motion preferences', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'How to play' }).click()
  const dialog = page.getByRole('dialog', { name: 'A quick seat at the table' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
})
