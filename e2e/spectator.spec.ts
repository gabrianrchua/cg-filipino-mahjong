import { expect, test, type Page } from '@playwright/test'
import { RoomSnapshotSchema, type RoomSnapshot } from '@cg-filipino-mahjong/shared'

interface CapturedSnapshots {
  readonly snapshots: RoomSnapshot[]
}

function captureSnapshots(page: Page): CapturedSnapshots {
  const snapshots: RoomSnapshot[] = []
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.startsWith('42')) return
      try {
        const event = JSON.parse(payload.slice(2)) as unknown
        if (!Array.isArray(event) || event[0] !== 'room.snapshot') return
        const parsed = RoomSnapshotSchema.safeParse(event[1])
        if (parsed.success) snapshots.push(parsed.data)
      } catch {
        // Ignore Engine.IO control frames and partial application frames.
      }
    })
  })
  return { snapshots }
}

async function bootstrapGuest(page: Page, displayName: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Display name').fill(displayName)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
}

test('spectators watch full rooms, reconnect and leave, then take over a bot with an authoritative hand', async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()))
  const [host, watcher, takeoverGuest] = await Promise.all(contexts.map((context) => context.newPage()))
  const watcherCapture = captureSnapshots(watcher)
  const takeoverCapture = captureSnapshots(takeoverGuest)

  try {
    await bootstrapGuest(host, 'Host')
    await host.getByRole('button', { name: 'Create room' }).click()
    await expect(host.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
    const roomCode = new URL(host.url()).pathname.split('/').at(-1)!
    for (let index = 0; index < 3; index += 1) {
      await host.getByRole('button', { name: 'Add bot' }).first().click()
      await expect(host.getByRole('heading', { name: `Bot ${index + 2}`, exact: true })).toBeVisible()
    }
    await host.getByRole('button', { name: 'I’m ready' }).click()
    await expect(host.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()

    await watcher.setViewportSize({ width: 390, height: 844 })
    await bootstrapGuest(watcher, 'Watcher')
    const roomCard = watcher.getByRole('article').filter({ hasText: roomCode })
    await expect(roomCard).toBeVisible()
    await expect(roomCard.getByRole('button', { name: 'Join' })).toBeDisabled()
    await expect(roomCard.getByRole('button', { name: 'Spectate' })).toBeEnabled()
    await roomCard.getByRole('button', { name: 'Spectate' }).click()

    await expect(watcher.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
    await expect(watcher.getByRole('status', { name: '1 spectator' })).toBeVisible()
    await expect(host.getByRole('status', { name: '1 spectator' })).toBeVisible()
    await expect(watcher.locator('[data-seat-position]')).toHaveCount(4)
    await expect.poll(() => watcher.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true)
    await expect(watcher.getByTestId('tile-rack')).toHaveCount(0)
    await expect(watcher.getByTestId('gameplay-actions')).toHaveCount(0)
    await expect(watcher.getByText('You', { exact: true })).toHaveCount(0)
    await expect(watcher.getByTestId('table-attention').getByText('Spectating', { exact: true })).toBeVisible()
    await expect.poll(() => watcherCapture.snapshots.some((snapshot) => (
      snapshot.stage === 'playing'
      && snapshot.self.role === 'spectator'
      && snapshot.self.seat === null
      && snapshot.privateState === null
      && snapshot.seats[2]?.melds.some((meld) => meld.kind === 'secret' && meld.visibility === 'masked')
    ))).toBe(true)

    const discardTile = host.locator('[data-hand-tile-id="suited-characters-9-1"]')
    await discardTile.getByRole('button', { name: /Select Nine of characters/u }).click()
    await host.getByRole('button', { name: 'Discard selected tile' }).click()
    await expect.poll(() => watcherCapture.snapshots.some((snapshot) => (
      snapshot.stage === 'playing'
      && snapshot.self.role === 'spectator'
      && snapshot.phase.kind === 'discard-responses'
      && snapshot.phase.latestDiscard.tileId === 'suited-characters-9-1'
    ))).toBe(true)
    await expect(watcher.getByText('Latest discard').first()).toBeVisible()

    await expect(watcher.getByRole('heading', { name: 'Ready for another hand?' })).toBeVisible()
    await expect.poll(() => watcherCapture.snapshots.some((snapshot) => (
      snapshot.stage === 'between-hands'
      && snapshot.self.role === 'spectator'
      && snapshot.result.kind === 'win'
    ))).toBe(true)
    await expect(watcher.getByRole('status', { name: '1 spectator' })).toBeVisible()

    await watcher.reload()
    await expect(watcher.getByRole('heading', { name: 'Ready for another hand?' })).toBeVisible()
    await expect(watcher.getByRole('status', { name: '1 spectator' })).toBeVisible()
    await expect(host.getByRole('status', { name: '1 spectator' })).toBeVisible()
    await expect(watcher.getByRole('button', { name: 'Stop spectating' })).toBeVisible()
    await watcher.getByRole('button', { name: 'Stop spectating' }).click()
    await expect(watcher.getByRole('heading', { name: 'Create a room' })).toBeVisible()
    await expect(host.getByRole('status', { name: '0 spectators' })).toBeVisible()

    await bootstrapGuest(takeoverGuest, 'Takeover Guest')
    await takeoverGuest.goto(`/room/${roomCode}`)
    await expect(takeoverGuest.getByRole('heading', { name: 'Choose how to enter.' })).toBeVisible()
    await takeoverGuest.getByRole('button', { name: 'Spectate' }).click()
    await expect(takeoverGuest.getByRole('heading', { name: 'Ready for another hand?' })).toBeVisible()
    await expect(takeoverGuest.getByRole('status', { name: '1 spectator' })).toBeVisible()
    await expect(takeoverGuest.getByRole('button', { name: 'Take over seat 2' })).toBeEnabled()
    await takeoverGuest.getByRole('button', { name: 'Take over seat 2' }).click()

    await expect(host.getByRole('status', { name: '0 spectators' })).toBeVisible()
    await expect.poll(() => takeoverCapture.snapshots.some((snapshot) => (
      snapshot.stage === 'between-hands' && snapshot.self.role === 'player' && snapshot.self.seat === 1
    ))).toBe(true)
    await Promise.all([
      host.getByRole('button', { name: 'I’m ready' }).click(),
      takeoverGuest.getByRole('button', { name: 'I’m ready' }).click(),
    ])
    await expect(takeoverGuest.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
    await expect.poll(() => takeoverCapture.snapshots.some((snapshot) => (
      snapshot.stage === 'playing'
      && snapshot.self.role === 'player'
      && snapshot.self.seat === 1
      && snapshot.privateState?.seat === 1
      && snapshot.privateState.concealedTiles.length > 0
    ))).toBe(true)
    await expect(takeoverGuest.getByTestId('tile-rack')).toBeVisible()
    await expect(takeoverGuest.getByRole('status', { name: '0 spectators' })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
