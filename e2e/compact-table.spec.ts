import { expect, test } from '@playwright/test'

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
]) {
  test(`bounds the play header, dense melds, and discard rows at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/room/MJ2345?preview=melds')
    const header = page.getByRole('banner')
    await expect(header).toHaveCount(1)
    await expect(header.getByLabel('Room code M J 2 3 4 5')).toBeVisible()
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(53)
    const title = page.getByRole('heading', { name: 'Mahjong table' })
    await expect(title).toBeAttached()
    expect((await title.boundingBox())!.height).toBe(1)
    for (const name of ['Copy room link', 'How to play']) {
      const control = header.getByRole('button', { name })
      const bounds = (await control.boundingBox())!
      expect(bounds.width).toBeGreaterThanOrEqual(44)
      expect(bounds.height).toBeGreaterThanOrEqual(44)
      await expect(control).toBeInViewport()
    }
    const lists = page.getByRole('region', { name: /^Public tiles for /u })
    await expect(lists).toHaveCount(4)
    for (const list of await lists.all()) {
      await expect(list.getByRole('listitem')).toHaveCount(5)
      await expect.poll(() => list.evaluate((element) => {
        const melds = Array.from(element.querySelectorAll('li'))
        const rowCount = new Set(melds.map((meld) => Math.round(meld.getBoundingClientRect().top))).size
        return rowCount
      })).toBe(1)
      expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
      await list.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      // Every tile of the final meld can be inspected without expanding the card.
      expect(await list.evaluate((element) => {
        const end = element.querySelector('li:last-child')!.getBoundingClientRect()
        const bounds = element.getBoundingClientRect()
        return end.right <= bounds.right + 1 && end.left >= bounds.left - 1
      })).toBe(true)
    }
    const pile = page.getByRole('region', { name: 'Discarded tiles', exact: true })
    await expect(pile.getByRole('img')).toHaveCount(48)
    expect(await pile.getByRole('img').evaluateAll((tiles) =>
      new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().top))).size,
    )).toBe(2)
    expect(await pile.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
    await pile.evaluate((element) => { element.scrollLeft = element.scrollWidth })
    expect(await pile.evaluate((element) => {
      const tile = element.querySelector('[data-tile-id]:last-child')!.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      return tile.right <= bounds.right + 1 && tile.left >= bounds.left - 1
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const hand = page.getByRole('region', { name: 'Your hand', exact: true })
    const before = await hand.boundingBox()
    await page.getByRole('region', { name: 'Public board' }).evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await hand.boundingBox()).toEqual(before)
  })
}

test('keeps compact help and clipboard feedback accessible without moving the board', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/room/MJ2345?preview=table')
  const help = page.getByRole('button', { name: 'How to play' })
  await help.click()
  await expect(page.getByRole('dialog', { name: 'A quick seat at the table' })).toBeVisible()
  await page.getByRole('button', { name: 'Close rules' }).click()
  await expect(help).toBeFocused()

  const board = page.getByRole('region', { name: 'Public board' })
  const before = await board.boundingBox()
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text: string) => {
      if (text !== new URL('/room/MJ2345', location.origin).href) throw new Error('Incorrect room link')
    } },
  }))
  await page.getByRole('button', { name: 'Copy room link' }).click()
  await expect(page.getByText('Room link copied.')).toBeVisible()
  expect(await board.boundingBox()).toEqual(before)

  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied') } },
  }))
  await page.getByRole('button', { name: 'Copy room link' }).click()
  const fallback = page.getByText('Copy this room link:', { exact: false })
  await expect(fallback).toBeVisible()
  await expect(fallback).toBeInViewport()
  expect(await board.boundingBox()).toEqual(before)

  await page.getByRole('link', { name: 'Filipino Mahjong home' }).click()
  await expect(page.getByRole('button', { name: 'How to play' })).toHaveText('How to play')
  await expect(page.getByRole('button', { name: 'Copy room link' })).toHaveCount(0)
})

test('updates meld scroll hints on keyboard scrolling and resizing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=melds')
  const list = page.getByRole('region', { name: 'Public tiles for Bot 3' })
  const frame = list.locator('..')
  await expect(frame).toHaveAttribute('data-scroll-left', 'false')
  await expect(frame).toHaveAttribute('data-scroll-right', 'true')
  await expect(list).toHaveAttribute('tabindex', '0')
  await list.scrollIntoViewIfNeeded()
  await list.focus()
  await list.press('ArrowRight')
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect(frame).toHaveAttribute('data-scroll-left', 'true')
  await list.press('ArrowLeft')
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect(frame).toHaveAttribute('data-scroll-left', 'false')
  await list.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(frame).toHaveAttribute('data-scroll-left', 'false')
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')
  await expect(list).not.toHaveAttribute('tabindex')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame).toHaveAttribute('data-scroll-right', 'true')
})

test('retains meld scroll position on updates, skips clipped flights, and resets for a new hand', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=motion-dense-meld')
  const list = page.getByRole('region', { name: 'Public tiles for Alexandria-Mari Santos' })
  await list.scrollIntoViewIfNeeded()
  await list.evaluate((element) => { element.scrollLeft = 20 })
  const before = await list.evaluate((element) => element.scrollLeft)
  expect(before).toBeGreaterThan(0)
  await page.evaluate(() => {
    const observed = window as typeof window & { flights: number }
    observed.flights = 0
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.motionFlight) observed.flights += 1
      }
    }).observe(document.body, { childList: true })
  })
  await page.getByRole('button', { name: 'Advance dense-meld preview' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(5)
  expect(await list.evaluate((element) => element.scrollLeft)).toBe(before)
  await expect(list.locator('..')).toHaveAttribute('data-scroll-right', 'true')
  expect(await page.evaluate(() => (window as typeof window & { flights: number }).flights)).toBe(0)
  await page.getByRole('button', { name: 'Reset hand preview' }).click()
  await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBe(0)
})

test('supports dense melds and header controls with doubled text', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 450 })
  await page.goto('/room/MJ2345?preview=melds')
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px' })
  for (const name of ['Copy room link', 'How to play']) {
    await expect(page.getByRole('button', { name })).toBeInViewport()
  }
  for (const list of await page.getByRole('region', { name: /^Public tiles for /u }).all()) {
    expect(await list.getByRole('listitem').evaluateAll((melds) =>
      new Set(melds.map((meld) => Math.round(meld.getBoundingClientRect().top))).size,
    )).toBe(1)
    expect(await list.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('allows a native horizontal swipe through melds on a touch screen', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Precise touch dispatch uses Chromium CDP.')
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await page.goto('/room/MJ2345?preview=melds')
    const list = page.getByRole('region', { name: 'Public tiles for Alexandria-Mari Santos' })
    await list.scrollIntoViewIfNeeded()
    const bounds = (await list.boundingBox())!
    const cdp = await context.newCDPSession(page)
    const start = { x: bounds.x + bounds.width - 10, y: bounds.y + bounds.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
    for (let step = 1; step <= 4; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x - step * 20, y: start.y, id: 1 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => list.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await expect(list.locator('..')).toHaveAttribute('data-scroll-left', 'true')
  } finally {
    await context.close()
  }
})

test('updates shared discard fades while scrolling and keeps flower details reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=table')
  const row = page.getByRole('region', { name: 'Discarded tiles', exact: true })
  const frame = row.locator('..')
  await expect(frame).toHaveAttribute('data-scroll-left', 'true')
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')
  await row.evaluate((element) => { element.scrollLeft = 0 })
  await expect(frame).toHaveAttribute('data-scroll-right', 'true')
  expect(await frame.evaluate((element) => getComputedStyle(element, '::after').backgroundImage)).toContain('linear-gradient')
  await row.focus()
  await row.press('ArrowRight')
  await expect.poll(() => row.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect(frame).toHaveAttribute('data-scroll-left', 'true')
  await row.press('ArrowLeft')
  await expect.poll(() => row.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect(frame).toHaveAttribute('data-scroll-left', 'false')
  await row.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')
  const flowers = page.getByRole('button', { name: 'Show 5 flowers for Alexandria-Mari Santos' })
  await flowers.focus()
  await expect(flowers).toBeInViewport()
  await flowers.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('img')).toHaveCount(5)
  await page.getByRole('button', { name: 'Close flowers' }).click()
  await expect(flowers).toBeFocused()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')
  await expect.poll(() => row.evaluate((element) => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)).toBe(true)
})

test('preserves discard inspection, follows additions at the end, and resets for a new hand', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=motion-pile')
  const pile = page.getByRole('region', { name: 'Discarded tiles', exact: true })
  await expect(pile.getByRole('img')).toHaveCount(47)
  await pile.evaluate((element) => { element.scrollLeft = 40 })
  await expect(pile.locator('..')).toHaveAttribute('data-scroll-right', 'true')
  await page.getByRole('button', { name: 'Advance pile preview' }).click()
  await expect(pile.getByRole('img')).toHaveCount(48)
  expect(await pile.evaluate((element) => element.scrollLeft)).toBe(40)
  await pile.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect(pile.locator('..')).toHaveAttribute('data-scroll-right', 'false')
  const before = await pile.evaluate((element) => element.scrollLeft)
  await page.getByRole('button', { name: 'Advance pile preview' }).click()
  await expect(pile.getByRole('img')).toHaveCount(49)
  await expect.poll(() => pile.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before)
  await expect(pile.locator('..')).toHaveAttribute('data-scroll-right', 'false')
  await page.getByRole('button', { name: 'Reset hand preview' }).click()
  await expect(pile.getByRole('img')).toHaveCount(0)
  await expect(pile).toHaveText('No discards yet')
  expect(await pile.evaluate((element) => element.scrollLeft)).toBe(0)
})

test('allows a native horizontal swipe through shared discards', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Precise touch dispatch uses Chromium CDP.')
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await page.goto('/room/MJ2345?preview=table')
    const pile = page.getByRole('region', { name: 'Discarded tiles', exact: true })
    await pile.evaluate((element) => { element.scrollLeft = 0 })
    await expect(pile.locator('..')).toHaveAttribute('data-scroll-right', 'true')
    await pile.scrollIntoViewIfNeeded()
    const bounds = (await pile.boundingBox())!
    const cdp = await context.newCDPSession(page)
    const start = { x: bounds.x + bounds.width - 10, y: bounds.y + bounds.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
    for (let step = 1; step <= 4; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x - step * 20, y: start.y, id: 1 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => pile.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  } finally {
    await context.close()
  }
})
