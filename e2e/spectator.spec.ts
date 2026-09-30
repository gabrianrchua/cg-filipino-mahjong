import { expect, test, type Page } from '@playwright/test'
import { ClientCommandSchema, RoomSnapshotSchema, type RoomSnapshot } from '@cg-filipino-mahjong/shared'

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

async function expectMobileRoomHeaderFits(page: Page, roomCode: string, count: number): Promise<void> {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const header = page.getByRole('banner')
    const controls = [
      header.getByRole('link', { name: 'Filipino Mahjong home' }),
      header.getByLabel(`Room code ${Array.from(roomCode).join(' ')}`),
      header.getByRole('button', { name: 'Copy room link' }),
      header.getByRole('status', { name: `${count} ${count === 1 ? 'spectator' : 'spectators'}` }),
      header.getByRole('button', { name: 'How to play' }),
    ]
    let previousRight = 0
    for (const control of controls) {
      await expect(control).toBeVisible()
      const bounds = await control.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(previousRight)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      previousRight = bounds!.x + bounds!.width
    }
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true)
  }
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
    await expectMobileRoomHeaderFits(host, roomCode, 0)
    await host.setViewportSize({ width: 1280, height: 720 })
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

    await expectMobileRoomHeaderFits(watcher, roomCode, 1)
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

for (const stage of ['waiting', 'playing'] as const) {
  for (const first of ['room.leave', 'room.takeover'] as const) {
    test(`blocks overlapping spectator membership requests during ${first} in ${stage}`, async ({ browser }) => {
      const contexts = await Promise.all([browser.newContext(), browser.newContext()])
      const [host, viewer] = await Promise.all(contexts.map((context) => context.newPage()))
      let holdCommand = false
      const heldCommand: { release?: () => void } = {}
      const membershipCommands: string[] = []
      await viewer.routeWebSocket(/\/socket\.io\//u, (route) => {
        const server = route.connectToServer()
        route.onMessage((message) => {
          if (typeof message === 'string' && /^42\d*\[/u.test(message)) {
            const event: unknown = JSON.parse(message.slice(message.indexOf('[')))
            if (Array.isArray(event) && event[0] === 'command') {
              const command = ClientCommandSchema.parse(event[1])
              if (command.type === 'room.leave' || command.type === 'room.takeover') {
                membershipCommands.push(command.type)
                if (holdCommand && command.type === first && !heldCommand.release) {
                  heldCommand.release = () => server.send(message)
                  return
                }
              }
            }
          }
          server.send(message)
        })
      })
      try {
        await bootstrapGuest(host, 'Host')
        await host.getByRole('button', { name: 'Create room' }).click()
        await expect(host.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
        const roomCode = new URL(host.url()).pathname.split('/').at(-1)!
        for (let index = 0; index < 3; index += 1) {
          await host.getByRole('button', { name: 'Add bot' }).first().click()
          await expect(host.getByRole('heading', { name: `Bot ${index + 2}`, exact: true })).toBeVisible()
        }
        if (stage === 'playing') {
          await host.getByRole('button', { name: 'I’m ready' }).click()
          await expect(host.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
        }
        await bootstrapGuest(viewer, 'Viewer')
        await viewer.goto(`/room/${roomCode}`)
        await viewer.getByRole('button', { name: 'Spectate', exact: true }).click()
        await expect(viewer.getByRole('status', { name: '1 spectator' })).toBeVisible()
        const leave = viewer.getByRole('button', { name: 'Stop spectating' })
        const takeover = viewer.getByRole('button', { name: 'Take over seat 2', exact: true })
        await expect(takeover).toBeEnabled()
        holdCommand = true
        await (first === 'room.leave' ? leave : takeover).click()
        await expect.poll(() => Boolean(heldCommand.release)).toBe(true)
        await expect(viewer.getByRole('button', { name: first === 'room.leave' ? 'Leaving…' : 'Stop spectating' })).toBeDisabled()
        for (const button of await viewer.getByRole('button', { name: /Take over seat/u }).all()) {
          await expect(button).toBeDisabled()
          await button.evaluate((element: HTMLButtonElement) => element.click())
        }
        if (first === 'room.takeover') await leave.evaluate((element: HTMLButtonElement) => element.click())
        expect(membershipCommands).toEqual([first])
        heldCommand.release!()
        if (first === 'room.leave') {
          await expect(viewer.getByRole('heading', { name: 'Create a room' })).toBeVisible()
          await viewer.reload()
          await expect(viewer.getByRole('heading', { name: 'Create a room' })).toBeVisible()
          await expect(host.getByText('Bot 2', { exact: true })).toBeVisible()
        } else if (stage === 'waiting') {
          await expect(viewer.getByRole('button', { name: 'I’m ready' })).toBeEnabled()
          await expect(host.getByRole('heading', { name: 'Viewer', exact: true })).toBeVisible()
        } else {
          await expect(viewer.getByTestId('tile-rack')).toBeVisible()
          await expect(viewer.getByRole('dialog', { name: 'A player is disconnected.' })).toHaveCount(0)
        }
        await expect(host.getByRole('status', { name: '0 spectators' })).toBeVisible()
        expect(membershipCommands).toEqual([first])
      } finally {
        await Promise.all(contexts.map((context) => context.close()))
      }
    })
  }
}
