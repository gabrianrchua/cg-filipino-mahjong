import { expect, test } from '@playwright/test'
import type { ClientCommand, CommandAcknowledgement, RoomSnapshot } from '@cg-filipino-mahjong/shared'
import { io, type Socket } from 'socket.io-client'

type SetupSocket = Socket<Record<string, never>, { command: (
  command: ClientCommand,
  acknowledge: (result: CommandAcknowledgement) => void,
) => void }>

function setupCommand(socket: SetupSocket, command: Omit<ClientCommand, 'commandId'>): Promise<CommandAcknowledgement> {
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
    await ben.getByRole('button', { name: 'Join an open seat' }).click()
    await expect(ben.getByRole('heading', { name: 'The table is almost ready.' })).toBeVisible()
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
    await expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeHidden()
    await page.getByRole('button', { name: 'Take over seat 2' }).click()
    await expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()
  } finally {
    host.disconnect()
  }
})

test('creates an unlisted guest room with a canonical share link and survives reload', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await page.getByLabel('Display name').fill('Ana')
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
  await page.getByLabel('Unlisted').check()
  await page.getByRole('button', { name: 'Create room' }).click()
  await expect(page).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
  await expect(page.getByRole('heading', { name: 'The table is almost ready.' })).toBeVisible()
  await page.getByRole('button', { name: 'Copy room link' }).click()
  await expect(page.getByText('Room link copied.')).toBeVisible()
  await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe(page.url())
  await page.reload()
  await expect(page.getByRole('heading', { name: 'The table is almost ready.' })).toBeVisible()
})

test('retains a direct room intent through guest bootstrap and reports a missing code', async ({ page }) => {
  await page.goto('/room/mj2345')
  await expect(page).toHaveURL(/\/room\/MJ2345$/u)
  await page.getByLabel('Display name').fill('Ben')
  await expect(page.getByRole('button', { name: 'Continue as guest' })).toBeEnabled()
  await page.getByLabel('Display name').press('Enter')
  await expect(page.getByRole('heading', { name: 'We couldn’t enter this room.' })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()
  const rack = page.getByTestId('tile-rack')
  await expect(rack.locator('[data-tile-id^="preview-hand-"]')).toHaveCount(17)
  await expect.poll(() => rack.evaluate((element) => {
    const scrollParent = element.parentElement
    return Boolean(scrollParent && element.scrollWidth > scrollParent.clientWidth)
  })).toBe(true)
  await expect.poll(async () => (await rack.locator('[data-tile-id="preview-hand-0"]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44)
  await expect(page.getByLabel('Secret meld, four concealed tiles')).toBeVisible()
  await expect(page.getByLabel('Nine of characters, latest discard')).toBeVisible()
  await expect(page.getByTestId('future-action-space')).toBeAttached()
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
