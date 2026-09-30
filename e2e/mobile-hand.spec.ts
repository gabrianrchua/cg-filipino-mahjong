import { expect, test } from '@playwright/test'

for (const viewport of [
  { width: 320, height: 568 }, { width: 375, height: 667 },
  { width: 390, height: 844 }, { width: 430, height: 932 },
]) {
  test(`packs full and short hands into predictable rows at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    for (const count of [17, 16, 15, 14, 10, 9, 7, 6]) {
      await page.goto(`/room/MJ2345?preview=${count === 17 ? 'arrangement' : `hand-${count}`}`)
      const rack = page.getByTestId('tile-rack')
      const tiles = rack.locator('[data-hand-tile-id]')
      await expect(tiles).toHaveCount(count)
      const boxes = await tiles.evaluateAll((elements) => elements.map((element) => {
        const { x, y, width } = element.getBoundingClientRect()
        return { x, y, width }
      }))
      const capacity = viewport.width === 320 ? 6 : viewport.width === 430 ? 8 : 7
      const columns = Math.min(count, Math.max(capacity, Math.ceil(count / 2)))
      expect(boxes.filter((box) => box.y === boxes[0]!.y)).toHaveLength(columns)
      expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(count > columns ? 2 : 1)
      expect(await rack.locator('..').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(count > capacity * 2)
      expect(boxes[0]!.width).toBe(44)
      expect(boxes[1]!.x - boxes[0]!.x).toBe(46)
      if (count > columns) {
        expect(boxes[columns]!.x).toBe(boxes[0]!.x)
        expect(boxes[columns]!.y).toBeGreaterThan(boxes[0]!.y)
      }
      await rack.locator('..').evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect(tiles.nth(columns - 1)).toBeInViewport()
      await tiles.last().scrollIntoViewIfNeeded()
      await expect(tiles.last()).toBeInViewport()
      if (count === 17) await page.screenshot({ path: test.info().outputPath('hand.png') })
      const hand = await page.getByRole('region', { name: 'Your hand', exact: true }).boundingBox()
      expect(hand!.y + hand!.height).toBeLessThanOrEqual(viewport.height)
      await expect(page.getByRole('button', { name: 'Discard selected tile' })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  })
}

test('offers optional arrangement while waiting and keeps preview preferences local', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=table')
  const saved = await page.evaluate(() => localStorage.getItem('cg-filipino-mahjong.handSort.v1'))
  const settings = page.getByRole('button', { name: 'Hand settings' })
  await settings.click()
  const sort = page.getByRole('checkbox', { name: 'Auto-sort hand' })
  await expect(sort).toBeChecked()
  await sort.uncheck()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toBeFocused()
  await settings.click()
  await page.getByRole('button', { name: 'Arrange hand', exact: true }).click()
  const tiles = page.getByTestId('tile-rack').locator('[data-hand-tile-id]')
  const first = await tiles.first().getAttribute('data-hand-tile-id')
  await tiles.first().getByRole('button', { name: /^Select /u }).click()
  await page.getByRole('button', { name: 'Move right' }).click()
  await expect(tiles.nth(1)).toHaveAttribute('data-hand-tile-id', first!)
  await page.getByRole('button', { name: 'Done arranging' }).click()
  await expect(page.getByRole('button', { name: 'Move right' })).toBeHidden()
  await settings.click()
  await expect(sort).not.toBeChecked()
  await sort.check()
  await page.getByRole('button', { name: 'Close settings' }).click()
  expect(await page.evaluate(() => localStorage.getItem('cg-filipino-mahjong.handSort.v1'))).toBe(saved)
})

test('uses one confirmation for discards and special actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=special')
  const actions = page.getByRole('region', { name: 'Your actions' })
  await expect(actions.getByRole('button')).toHaveCount(1)
  const secret = actions.getByRole('radio', { name: 'Secret' })
  await secret.check()
  await expect(actions.getByRole('button', { name: 'Declare secret' })).toBeVisible()
  const tile = page.getByTestId('tile-rack').locator('[data-hand-tile-id]').first().getByRole('button', { name: /^Select /u })
  await tile.click()
  await expect(secret).not.toBeChecked()
  await expect(actions.getByRole('button', { name: 'Discard selected tile' })).toBeVisible()
  await secret.check()
  await expect(page.getByTestId('tile-rack').getByRole('button', { name: /^Deselect /u })).toHaveCount(0)
  await expect(actions.getByRole('button', { name: 'Declare secret' })).toBeVisible()
})

test('reorders between rows with the keyboard and preserves order on rotation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=arrangement')
  const tiles = page.getByTestId('tile-rack').locator('[data-hand-tile-id]')
  const first = await tiles.first().getAttribute('data-hand-tile-id')
  const handle = tiles.first().getByRole('button', { name: /^Reorder /u })
  await handle.focus()
  await handle.press('Enter')
  await handle.press('ArrowDown')
  await handle.press('Enter')
  await expect(tiles.nth(9)).toHaveAttribute('data-hand-tile-id', first!)
  await expect(tiles).toHaveCount(17)
  const order = await tiles.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-hand-tile-id')))
  await page.setViewportSize({ width: 844, height: 390 })
  await expect.poll(() => tiles.evaluateAll((elements) => new Set(elements.map((element) => element.getBoundingClientRect().y)).size)).toBe(1)
  expect(await tiles.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-hand-tile-id')))).toEqual(order)
})

test('cancels an unfinished reorder when rotation or a new draw changes the hand', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=motion-draw')
  const tiles = page.getByTestId('tile-rack').locator('[data-hand-tile-id]')
  const order = () => tiles.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-hand-tile-id')))
  const before = await order()
  const startDrag = async () => {
    // Allow resize events and their observers to finish before starting a new gesture.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const handle = tiles.first().getByRole('button', { name: /^Reorder /u })
    await handle.focus()
    await handle.press('Enter')
    await handle.press('ArrowRight')
    await expect(page.locator('[data-dnd-dragging]')).toHaveCount(1)
  }
  await startDrag()
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.locator('[data-dnd-dragging], [data-dnd-placeholder]')).toHaveCount(0)
  expect(await order()).toEqual(before)
  await page.setViewportSize({ width: 390, height: 844 })
  await startDrag()
  await page.getByRole('button', { name: 'Advance draw preview' }).evaluate((element: HTMLButtonElement) => element.click())
  await expect(page.locator('[data-dnd-dragging], [data-dnd-placeholder]')).toHaveCount(0)
  await expect(tiles).toHaveCount(17)
  expect((await order()).filter((tileId) => tileId !== 'preview-hand-16')).toEqual(before)
})

test('allows native hand swipes and deliberate touch dragging between rows', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Precise touch gestures use Chromium CDP.')
  const context = await browser.newContext({ baseURL: 'http://localhost:5173', hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await page.goto('/room/MJ2345?preview=arrangement')
    const rack = page.getByTestId('tile-rack')
    const scroller = rack.locator('..')
    const tiles = rack.locator('[data-hand-tile-id]')
    const cdp = await context.newCDPSession(page)
    const rackBounds = (await rack.boundingBox())!
    const y = rackBounds.y + 25
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y, id: 1 }] })
    for (const x of [260, 220, 180, 140]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await expect(page.locator('[data-dnd-dragging]')).toHaveCount(0)
    // Reload to finish the native swipe's momentum before measuring a new drag.
    await page.goto('/room/MJ2345?preview=arrangement')
    await tiles.first().scrollIntoViewIfNeeded()
    const firstId = await tiles.first().getAttribute('data-hand-tile-id')
    const source = (await tiles.first().getByRole('button', { name: /^Reorder /u }).boundingBox())!
    const target = (await tiles.nth(9).getByRole('button', { name: /^Reorder /u }).boundingBox())!
    const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
    const end = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 2 }] })
    await expect(page.locator('[data-dnd-dragging]')).toHaveCount(1)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...end, id: 2 }] })
    await expect.poll(() => page.locator('[data-dnd-placeholder]').evaluate((element) => element.getBoundingClientRect().y)).toBeGreaterThan(source.y)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(tiles).toHaveCount(17)
    await expect(tiles.nth(9)).toHaveAttribute('data-hand-tile-id', firstId!)
  } finally {
    await context.close()
  }
})


test('shrinks the row width and clamps scrolling after a tile leaves the hand', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=motion-discard')
  const rack = page.getByTestId('tile-rack')
  const scroller = rack.locator('..')
  const rowCounts = () => rack.locator('[data-hand-tile-id]').evaluateAll((elements) => {
    const rows = new Map<number, number>()
    for (const element of elements) {
      const top = Math.round(element.getBoundingClientRect().top)
      rows.set(top, (rows.get(top) ?? 0) + 1)
    }
    return [...rows.values()]
  })
  await expect.poll(rowCounts).toEqual([9, 8])
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  const oldOverflow = await scroller.evaluate((element) => element.scrollWidth - element.clientWidth)
  await page.getByRole('button', { name: 'Advance discard preview' }).click()
  await expect.poll(rowCounts).toEqual([8, 8])
  expect(await scroller.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThan(oldOverflow)
  expect(await scroller.evaluate((element) => element.scrollLeft <= element.scrollWidth - element.clientWidth)).toBe(true)
})
