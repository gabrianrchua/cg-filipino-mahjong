import { expect, test } from '@playwright/test'
import type { ClientCommand, CommandAcknowledgement, RoomSnapshot } from '@cg-filipino-mahjong/shared'
import { io, type Socket } from 'socket.io-client'

type SetupSocket = Socket<Record<string, never>, { command: (
  command: ClientCommand,
  acknowledge: (result: CommandAcknowledgement) => void,
) => void }>

type CommandDraft = ClientCommand extends infer Command
  ? Command extends ClientCommand ? Omit<Command, 'commandId'> : never
  : never

function setupCommand(socket: SetupSocket, command: CommandDraft): Promise<CommandAcknowledgement> {
  return new Promise((resolve) => socket.emit('command', { ...command, commandId: crypto.randomUUID() } as ClientCommand, resolve))
}

function nextSetupSnapshot(socket: SetupSocket): Promise<RoomSnapshot> {
  return new Promise((resolve) => socket.once('room.snapshot', resolve))
}

test('publishes public rooms live and admits a second guest through the join flow', async ({ browser }) => {
  const anaContext = await browser.newContext()
  const benContext = await browser.newContext()
  const ana = await anaContext.newPage()
  const ben = await benContext.newPage()
  try {
    await Promise.all([ana.goto('/'), ben.goto('/')])
    await ana.getByLabel('Display name').fill('Ana')
    await ben.getByLabel('Display name').fill('Ben')
    await Promise.all([
      ana.getByRole('button', { name: 'Continue as guest' }).click(),
      ben.getByRole('button', { name: 'Continue as guest' }).click(),
    ])
    await expect(ana.getByRole('heading', { name: 'Create a room' })).toBeVisible()
    await expect(ben.getByRole('heading', { name: 'Public rooms', exact: true })).toBeVisible()
    await ana.getByRole('button', { name: 'Create room' }).click()
    await expect(ana).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const roomCode = new URL(ana.url()).pathname.split('/').at(-1)!
    const room = ben.getByRole('article').filter({ hasText: roomCode })
    await expect(room).toBeVisible()
    await room.getByRole('button', { name: 'Join room' }).click()
    const roster = ben.getByRole('region', { name: 'Current room roster' })
    await expect(roster.getByRole('listitem')).toHaveCount(4)
    await expect(roster).toContainText('Ana')
    await expect(roster.getByText('Open seat')).toHaveCount(3)
    await ben.getByRole('button', { name: 'Join an open seat' }).click()
    await expect(ben.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
  } finally {
    await Promise.all([anaContext.close(), benContext.close()])
  }
})

test('routes an active room through explicit bot-seat takeover before table admission', async ({ page }) => {
  const host = io('http://localhost:5173', { forceNew: true, reconnection: false, transports: ['websocket'] }) as SetupSocket
  try {
    await new Promise<void>((resolve, reject) => { host.once('connect', resolve); host.once('connect_error', reject) })
    await setupCommand(host, { type: 'session.bootstrap', displayName: 'Host' })
    const createdEvent = nextSetupSnapshot(host)
    await setupCommand(host, { type: 'room.create', visibility: 'public' })
    let snapshot = await createdEvent
    for (const seat of [1, 2, 3] as const) {
      const changed = nextSetupSnapshot(host)
      await setupCommand(host, {
        type: 'room.configure-seat', roomId: snapshot.roomId,
        expectedRoomRevision: snapshot.roomRevision, seat, controller: 'bot',
      })
      snapshot = await changed
    }
    const started = nextSetupSnapshot(host)
    await setupCommand(host, {
      type: 'room.set-ready', roomId: snapshot.roomId, readinessId: snapshot.readinessId, ready: true,
    })
    snapshot = await started
    host.disconnect()

    await page.goto('/')
    await page.getByLabel('Display name').fill('Takeover Guest')
    await page.getByRole('button', { name: 'Continue as guest' }).click()
    const room = page.getByRole('article').filter({ hasText: snapshot.roomCode })
    await room.getByRole('button', { name: 'Take over a bot' }).click()
    await expect(page.getByRole('heading', { name: 'Choose how to join.' })).toBeVisible()
    const roster = page.getByRole('region', { name: 'Current room roster' })
    await expect(roster).toContainText('Host')
    await expect(roster.getByText(/^Bot [234]$/u)).toHaveCount(3)
    await expect(page.getByRole('heading', { name: 'Mahjong table' })).toBeHidden()
    await page.getByRole('button', { name: 'Take over seat 2' }).click()
    await expect(page.getByRole('heading', { name: 'Choose how to join.' })).toBeHidden()
    await expect(page.getByRole('dialog', { name: 'A player is disconnected.' })).toBeVisible()
    await expect(page.locator('h1').filter({ hasText: 'Mahjong table' })).toBeAttached()
  } finally {
    host.disconnect()
  }
})

test('creates an unlisted guest room with a canonical share link and survives reload', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  }
  await page.goto('/')
  await page.getByLabel('Display name').fill('Ana')
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
  await page.getByLabel('Unlisted').check()
  await page.getByRole('button', { name: 'Create room' }).click()
  await expect(page).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
  await expect(page.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
  await page.getByRole('button', { name: 'Copy room link' }).click()
  if (browserName === 'chromium') {
    await expect(page.getByText('Room link copied.')).toBeVisible()
    await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe(page.url())
  } else {
    await expect(page.getByRole('status').filter({ hasText: /Room link copied|Copy this room link/u })).toBeVisible()
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
})

test('retains a direct room intent through guest bootstrap and reports a missing code', async ({ page }) => {
  await page.goto('/room/mj2345')
  await expect(page).toHaveURL(/\/room\/MJ2345$/u)
  await page.getByLabel('Display name').fill('Ben')
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeEnabled()
  await page.getByLabel('Display name').press('Enter')
  await expect(page.getByRole('heading', { name: 'This room was not found.' })).toBeVisible()
  await expect(page.getByText('The room was not found.')).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
  const layout = await page.evaluate(() => {
    const hand = document.querySelector('[aria-labelledby="hand-title"]')?.getBoundingClientRect()
    return {
      pageHeight: document.documentElement.scrollHeight,
      handTop: hand?.top ?? Number.POSITIVE_INFINITY,
      handBottom: hand?.bottom ?? Number.POSITIVE_INFINITY,
    }
  })
  expect(layout.pageHeight).toBeLessThanOrEqual(844)
  expect(layout.handTop).toBeGreaterThan(0)
  expect(layout.handBottom).toBeLessThanOrEqual(844)
  const rack = page.getByTestId('tile-rack')
  await expect(rack.locator('[data-tile-id^="preview-hand-"]')).toHaveCount(17)
  await expect.poll(() => rack.evaluate((element) => {
    const scrollParent = element.parentElement
    return Boolean(scrollParent && element.scrollWidth > scrollParent.clientWidth)
  })).toBe(true)
  await expect.poll(async () => (await rack.locator('[data-tile-id="preview-hand-0"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
  await expect(page.getByLabel('Secret meld, four concealed tiles')).toBeVisible()
  await expect(page.getByLabel('Nine of characters, latest discard')).toBeVisible()
  await expect(page.getByTestId('gameplay-actions')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Hand settings' })).toBeInViewport()
  for (const name of ['Sort hand', 'Move left', 'Move right', 'Discard selected tile']) {
    await expect(page.getByRole('button', { name })).toBeHidden()
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('centers selected tiles and reorder handles while marking the drawn tile', async ({ page }) => {
  await page.goto('/room/MJ2345?preview=arrangement')
  const rack = page.getByTestId('tile-rack')

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const tileId of ['preview-hand-0', 'preview-hand-16']) {
      const slot = rack.locator(`[data-hand-tile-id="${tileId}"]`)
      await slot.getByRole('button', { name: /^Select /u }).click()
      const offsets = await slot.evaluate((element) => {
        const tile = element.querySelector('[data-tile-id]')
        const handle = element.querySelectorAll('button')[1]
        if (!tile || !handle) throw new Error('Expected tile and reorder handle')
        const center = (rect: DOMRect) => rect.left + rect.width / 2
        const slotCenter = center(element.getBoundingClientRect())
        return {
          tile: center(tile.getBoundingClientRect()) - slotCenter,
          handle: center(handle.getBoundingClientRect()) - slotCenter,
        }
      })
      expect(Math.abs(offsets.tile)).toBeLessThan(1)
      expect(Math.abs(offsets.handle)).toBeLessThan(1)
    }

    const normalTop = await rack.locator('[data-hand-tile-id="preview-hand-16"]').evaluate((tile) => tile.getBoundingClientRect().top)
    const drawnTile = rack.locator('[data-hand-tile-id="preview-hand-16"] [data-tile-id]')
    const drawnTop = await drawnTile.evaluate((tile) => tile.getBoundingClientRect().top)
    expect(drawnTop).toBeLessThan(normalTop)
    await expect(drawnTile).toHaveCSS('outline-style', 'none')
    await expect(drawnTile.locator('svg > rect')).toHaveCSS('stroke', 'rgb(18, 101, 79)')
    await expect(drawnTile.locator('svg > path')).toHaveCSS('stroke', 'rgb(18, 101, 79)')
  }
})

test('shows hand scroll hints only toward hidden tiles on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=arrangement')
  const rack = page.getByTestId('tile-rack')
  const frame = rack.locator('..').locator('..')
  const scroller = rack.locator('..')

  await expect(frame).toHaveAttribute('data-scroll-left', 'false')
  await expect(frame).toHaveAttribute('data-scroll-right', 'true')
  expect(await frame.evaluate((element) => getComputedStyle(element, '::after').backgroundImage)).toContain('linear-gradient')
  await scroller.evaluate((element) => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2 })
  await expect(frame).toHaveAttribute('data-scroll-left', 'true')
  await expect(frame).toHaveAttribute('data-scroll-right', 'true')
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect(frame).toHaveAttribute('data-scroll-left', 'true')
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')

  await page.setViewportSize({ width: 1280, height: 844 })
  await expect(frame).toHaveAttribute('data-scroll-left', 'false')
  await expect(frame).toHaveAttribute('data-scroll-right', 'false')
  expect(await frame.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none')
})

test('sorts, selects, and reorders the local hand with buttons, mouse, and keyboard', async ({ page }) => {
  await page.goto('/room/MJ2345?preview=arrangement')
  const rack = page.getByTestId('tile-rack')
  const sortButton = page.getByRole('button', { name: 'Sort hand' })
  await expect(sortButton).toHaveAttribute('aria-pressed', 'true')
  const order = () => rack.locator('[data-hand-tile-id]').evaluateAll((tiles) => (
    tiles.map((tile) => tile.getAttribute('data-hand-tile-id'))
  ))

  const initial = await order()
  await rack.locator('[data-hand-tile-id="preview-hand-0"]').getByRole('button', { name: 'Select One of sticks' }).click()
  await page.getByRole('button', { name: 'Move right' }).click()
  await expect.poll(order).toEqual([
    initial[1], initial[0], ...initial.slice(2),
  ])

  await sortButton.click()
  await expect(sortButton).toHaveAttribute('aria-pressed', 'true')
  const sorted = await order()
  expect(sorted[0]).toBe('preview-hand-0')
  const mouseSource = rack.locator('[data-hand-tile-id="preview-hand-0"]')
  const mouseTarget = rack.locator('[data-hand-tile-id="preview-hand-4"]')
  await mouseSource.getByRole('button', { name: 'Reorder One of sticks' }).scrollIntoViewIfNeeded()
  await mouseSource.getByRole('button', { name: 'Reorder One of sticks' }).hover()
  await mouseTarget.hover()
  const sourceBox = await mouseSource.getByRole('button', { name: 'Reorder One of sticks' }).boundingBox()
  const targetBox = await mouseTarget.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Expected visible hand tiles')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2)
  await expect(page.locator('[data-dnd-dragging]')).toHaveCount(1)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await expect.poll(() => page.locator('[data-dnd-placeholder]').evaluate((element) => element.getBoundingClientRect().x)).toBeGreaterThan(sourceBox.x + sourceBox.width)
  await page.mouse.up()
  await expect.poll(order).not.toEqual(sorted)
  await expect(sortButton).toHaveAttribute('aria-pressed', 'false')

  const beforeKeyboard = await order()
  const keyboardTile = beforeKeyboard[2]!
  const keyboardHandle = rack.locator(`[data-hand-tile-id="${keyboardTile}"]`).getByRole('button', { name: /^Reorder /u })
  await keyboardHandle.focus()
  await keyboardHandle.press('Enter')
  await keyboardHandle.press('ArrowRight')
  await keyboardHandle.press('Enter')
  await expect.poll(order).not.toEqual(beforeKeyboard)
})

test('uses a deliberate touch hold to reorder without disabling rack scrolling', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'This test uses Chromium CDP to dispatch precise synthetic touch events.')
  const context = await browser.newContext({
    baseURL: 'http://localhost:5173', hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  try {
    await page.goto('/room/MJ2345?preview=arrangement')
    const rack = page.getByTestId('tile-rack')
    const source = rack.locator('[data-hand-tile-id="preview-hand-0"]')
    const target = rack.locator('[data-hand-tile-id]').nth(1)
  const targetId = await target.getAttribute('data-hand-tile-id')
    const handle = source.getByRole('button', { name: 'Reorder One of sticks' })
    await handle.scrollIntoViewIfNeeded()
    const sourceBox = await handle.boundingBox()
    const targetBox = await target.boundingBox()
    if (!sourceBox || !targetBox) throw new Error('Expected visible hand tiles')

    const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
    const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 }
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 41 }] })
    await page.waitForTimeout(275)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...end, id: 41 }] })
    await page.waitForTimeout(100)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

    await expect.poll(() => rack.locator('[data-hand-tile-id]').first().getAttribute('data-hand-tile-id')).toBe(targetId)
    await expect.poll(() => rack.evaluate((element) => element.parentElement!.scrollWidth > element.parentElement!.clientWidth)).toBe(true)
  } finally {
    await context.close()
  }
})

test('animates recipient-safe draw, discard, and resolved meld destinations', async ({ page }) => {
  for (const kind of ['draw', 'discard', 'meld'] as const) {
    await page.goto(`/room/MJ2345?preview=motion-${kind}`)
    await page.evaluate(() => {
      const watched = window as typeof window & { observedFlights?: string[] }
      watched.observedFlights = []
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLElement && node.dataset.motionFlight) {
              watched.observedFlights?.push(node.dataset.motionFlight)
            }
          }
        }
      }).observe(document.body, { childList: true })
    })
    await page.locator(kind === 'discard' ? '[data-hand-tile-id="preview-hand-16"]' : '[data-motion-wall]')
      .evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }))
    await expect.poll(() => page.evaluate((motionKind) => {
      const selector = motionKind === 'discard'
        ? '[data-hand-tile-id="preview-hand-16"] [data-tile-id]'
        : '[data-motion-wall] .tile-back'
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight)
    }, kind)).toBe(true)
    // Flights are suppressed for destinations clipped by the board scroller.
    if (kind !== 'draw') {
      await page.locator(kind === 'discard' ? '[data-motion-wall]' : '[data-seat-position="local"]')
        .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    }
    await page.getByRole('button', { name: `Advance ${kind} preview` }).evaluate((button: HTMLButtonElement) => button.click())
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { observedFlights?: string[] }
    ).observedFlights ?? [])).toContain(kind)
    await expect(page.locator('[data-motion-flight]')).toHaveCount(0)
    if (kind === 'draw') await expect(page.locator('[data-hand-tile-id="preview-hand-16"]')).toBeVisible()
    if (kind === 'discard') await expect(page.locator('[data-motion-discard] [data-tile-id="preview-hand-16"]')).toBeVisible()
    if (kind === 'meld') await expect(page.locator('[data-motion-meld-id="00000000-0000-4000-8000-000000000585"] [data-tile-id]')).toHaveCount(3)
  }
})

test('shows the destination immediately when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/room/MJ2345?preview=motion-draw')
  await page.getByRole('button', { name: 'Advance draw preview' }).click()
  await expect(page.locator('[data-hand-tile-id="preview-hand-16"]')).toBeVisible()
  await expect(page.locator('[data-motion-flight]')).toHaveCount(0)
})

test('does not animate a tile across content clipped by the board scroller', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=motion-meld')
  await page.getByRole('region', { name: 'Public board' }).evaluate((element) => { element.scrollTop = 0 })
  await page.evaluate(() => {
    const watched = window as typeof window & { observedFlights?: string[] }
    watched.observedFlights = []
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && node.dataset.motionFlight) watched.observedFlights?.push(node.dataset.motionFlight)
      }
    }).observe(document.body, { childList: true })
  })
  await page.getByRole('button', { name: 'Advance meld preview' }).click()
  await expect(page.locator('[data-motion-meld-id="00000000-0000-4000-8000-000000000585"] [data-tile-id]')).toHaveCount(3)
  expect(await page.evaluate(() => (window as typeof window & { observedFlights?: string[] }).observedFlights)).toEqual([])
})

test('keeps claim choices reachable on a phone and keyboard-inspectable before confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/room/MJ2345?preview=claims')
  const actions = page.getByTestId('gameplay-actions')
  await expect(actions).toBeVisible()
  await expect(actions.getByRole('radio')).toHaveCount(6)
  await expect(actions.getByText('Chow · option 1')).toBeVisible()
  await expect(actions.getByText('Chow · option 2')).toBeVisible()

  const pass = actions.getByRole('radio', { name: /Pass/u })
  await pass.focus()
  await pass.press('Space')
  await expect(pass).toBeChecked()
  await expect(actions.getByRole('button', { name: 'Submit pass' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('shows special meld and manual win choices without replacement or timer controls', async ({ page }) => {
  await page.goto('/room/MJ2345?preview=special')
  const actions = page.getByTestId('gameplay-actions')
  await expect(actions.getByRole('radio', { name: /Win/u })).toBeVisible()
  await expect(actions.getByRole('radio', { name: /Secret/u })).toBeVisible()
  await expect(actions.getByRole('radio', { name: /Sagása/u })).toBeVisible()
  await expect(actions.getByRole('button', { name: /replace flower|take gift/iu })).toHaveCount(0)
  await expect(page.getByText(/seconds remaining|time remaining/iu)).toHaveCount(0)
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'small phone', width: 320, height: 568 },
  { name: 'phone landscape', width: 844, height: 390 },
]) {
  test(`lays out the table at ${viewport.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/room/MJ2345?preview=table')
    await expect(page.getByLabel('Mahjong table with four seats')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await page.goto('/room/MJ2345?preview=claims')
    const hand = page.getByRole('region', { name: 'Your hand', exact: true })
    const confirm = page.getByRole('button', { name: 'Select an action' })
    await expect(confirm).toBeVisible()
    for (const element of [hand, confirm]) {
      const bounds = await element.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    }
    const before = await hand.boundingBox()
    await page.getByRole('region', { name: 'Public board' }).evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await hand.boundingBox()).toEqual(before)
  })
}

test('opens flower details and returns focus to the compact count', async ({ page }) => {
  await page.goto('/room/MJ2345?preview=table')
  const trigger = page.getByRole('button', { name: /Show .* flowers? for Bot 3/u })
  const row = page.getByRole('group', { name: 'Flowers and discards for Bot 3' })
  await expect(row.locator('> :first-child')).toHaveAttribute('aria-label', 'Show 1 flower for Bot 3')
  const bounds = (await trigger.boundingBox())!
  expect(bounds.width).toBeGreaterThanOrEqual(44)
  expect(bounds.height).toBeGreaterThanOrEqual(44)
  await trigger.focus()
  await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Bot 3’s 1 flower' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'Red dragon' })).toBeVisible()
  await page.getByRole('button', { name: 'Close flowers' }).click()
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('keeps controls reachable with doubled text size on a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 450 })
  await page.goto('/room/MJ2345?preview=claims')
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px' })
  const pass = page.getByRole('radio', { name: 'Pass', exact: true })
  await pass.focus()
  await pass.press('Space')
  await expect(pass).toBeChecked()
  for (const control of [page.getByRole('button', { name: 'Submit pass' }), page.getByRole('button', { name: 'Hand settings' })]) {
    await control.scrollIntoViewIfNeeded()
    const bounds = await control.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(450)
  }
})

test('honors reduced-motion preferences', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByRole('button', { name: 'How to play' }).click()
  const dialog = page.getByRole('dialog', { name: 'A quick seat at the table' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
})
