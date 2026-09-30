import { expect, test, type Page } from '@playwright/test'

async function bootstrapGuest(page: Page, displayName: string) {
  await page.goto('/')
  await page.getByLabel('Display name').fill(displayName)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
}

async function joinRoom(page: Page, roomCode: string) {
  await page.goto(`/room/${roomCode}`)
  await expect(page.getByRole('heading', { name: 'Choose how to enter.' })).toBeVisible()
  await page.getByRole('button', { name: 'Join an open seat' }).click()
  await expect(page.getByRole('heading', { name: 'Waiting room' })).toBeVisible()
}

function seatFor(page: Page, name: string) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) })
}

test('starts a phone-sized one-human table with three automatically-ready bots', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await bootstrapGuest(page, 'Ana')
  await page.getByRole('button', { name: 'Create room' }).click()
  await expect(page.getByRole('heading', { name: 'Waiting room' })).toBeVisible()

  await expect(page.getByLabel('Four room seats').getByRole('article')).toHaveCount(4)
  await expect(seatFor(page, 'Ana')).toContainText('Not ready')
  await expect(seatFor(page, 'Ana')).toContainText('You')

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Add bot' }).first().click()
    await expect(page.getByRole('heading', { name: `Bot ${index + 2}`, exact: true })).toBeVisible()
  }

  await expect(page.getByRole('heading', { name: /^Bot [234]$/u })).toHaveCount(3)
  await expect(page.getByText('Ready', { exact: true })).toHaveCount(3)
  await expect(page.getByText('0 of 1 humans ready.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

  await page.getByRole('button', { name: 'I’m ready' }).click()
  await expect(page.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
})

test('gives four humans equal room controls, resets readiness, and starts on the final ready snapshot', async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()))
  const [ana, ben, cora, dan] = await Promise.all(contexts.map((context) => context.newPage()))
  try {
    await Promise.all([
      bootstrapGuest(ana, 'Ana'),
      bootstrapGuest(ben, 'Ben'),
      bootstrapGuest(cora, 'Cora'),
      bootstrapGuest(dan, 'Dan'),
    ])

    await ana.getByRole('button', { name: 'Create room' }).click()
    await expect(ana).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const roomCode = new URL(ana.url()).pathname.split('/').at(-1)!

    await joinRoom(ben, roomCode)
    await ana.getByRole('button', { name: 'I’m ready' }).click()
    await expect(seatFor(ana, 'Ana')).toContainText('Ready')

    await joinRoom(cora, roomCode)
    await expect(seatFor(ana, 'Ana')).toContainText('Not ready')
    await expect(seatFor(ben, 'Ana')).toContainText('Not ready')
    await joinRoom(dan, roomCode)

    await ben.getByLabel('Unlisted').click()
    await expect(ana.getByLabel('Unlisted')).toBeChecked()
    await cora.getByLabel('Public').click()
    await expect(ben.getByLabel('Public')).toBeChecked()

    for (const page of [ana, ben, cora, dan]) {
      await expect(page.getByRole('button', { name: 'Add bot' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'I’m ready' })).toBeEnabled()
    }

    await Promise.all([ana, ben, cora].map((page) => page.getByRole('button', { name: 'I’m ready' }).click()))
    await expect(dan.getByText('3 of 4 humans ready.')).toBeVisible()
    await dan.getByRole('button', { name: 'I’m ready' }).click()

    await Promise.all([ana, ben, cora, dan].map((page) => (
      expect(page.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
    )))
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('blocks the table for a disconnect, shares the replacement vote, and permits a later abort', async ({ browser }) => {
  const anaContext = await browser.newContext()
  const benContext = await browser.newContext()
  const coraContext = await browser.newContext()
  const ana = await anaContext.newPage()
  const ben = await benContext.newPage()
  const cora = await coraContext.newPage()
  try {
    await Promise.all([
      bootstrapGuest(ana, 'Ana'),
      bootstrapGuest(ben, 'Ben'),
      bootstrapGuest(cora, 'Cora'),
    ])
    await ana.getByRole('button', { name: 'Create room' }).click()
    await expect(ana).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const roomCode = new URL(ana.url()).pathname.split('/').at(-1)!
    await joinRoom(ben, roomCode)
    await joinRoom(cora, roomCode)
    await ana.getByRole('button', { name: 'Add bot' }).click()
    // Roster changes replace the readiness ID; every guest must see the new roster before readying.
    await Promise.all([ana, ben, cora].map((page) => (
      expect(page.getByRole('heading', { name: 'Bot 4', exact: true })).toBeVisible()
    )))
    await Promise.all([ana, ben, cora].map((page) => page.getByRole('button', { name: 'I’m ready' }).click()))
    await Promise.all([ana, ben, cora].map((page) => (
      expect(page.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
    )))

    await cora.close()
    const anaDialog = ana.getByRole('dialog', { name: 'A player is disconnected.' })
    const benDialog = ben.getByRole('dialog', { name: 'A player is disconnected.' })
    await expect(anaDialog).toBeVisible()
    await expect(benDialog).toContainText('Cora')
    await expect(ana.getByTestId('gameplay-actions')).toHaveCount(0)

    await anaDialog.getByRole('button', { name: 'Replace Cora with a bot' }).focus()
    await ana.keyboard.press('Tab')
    await expect.poll(async () => anaDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await ana.keyboard.press('Escape')
    await expect(anaDialog).toBeVisible()

    await anaDialog.getByRole('button', { name: 'Replace Cora with a bot' }).click()
    await expect(benDialog).toContainText('1 of 2 approvals')

    const returnedCora = await coraContext.newPage()
    await returnedCora.goto(`/room/${roomCode}`)
    await expect(returnedCora.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
    await expect(anaDialog).toBeHidden()
    await expect(benDialog).toBeHidden()
    await returnedCora.close()

    await expect(anaDialog).toBeVisible()
    await anaDialog.getByRole('button', { name: 'Replace Cora with a bot' }).click()
    await expect(benDialog).toContainText('1 of 2 approvals')
    await benDialog.getByRole('button', { name: 'Approve' }).click()
    await expect(anaDialog).toBeHidden()
    await expect(benDialog).toBeHidden()

    await benContext.close()
    const abortDialog = ana.getByRole('dialog', { name: 'A player is disconnected.' })
    await expect(abortDialog).toContainText('Ben')
    await abortDialog.getByRole('button', { name: 'Propose aborting the hand' }).click()
    await expect(ana.getByRole('heading', { name: 'Ready for another hand?' })).toBeVisible()
    await expect(ana.getByRole('heading', { name: 'The hand was aborted.' })).toBeVisible()
    await expect(ana.getByText('Dealer remains')).toBeVisible()
    await expect(ana.getByText('1 disconnected human must return before the hand can start.')).toBeVisible()
    await expect(abortDialog).toBeVisible()
    await expect(abortDialog.getByRole('button', { name: 'Propose aborting the hand' })).toHaveCount(0)
    await abortDialog.getByRole('button', { name: 'Replace Ben with a bot' }).click()
    await expect(abortDialog).toBeHidden()
    await expect(ana.getByText('0 of 1 humans ready.')).toBeVisible()
    await ana.getByRole('button', { name: 'I’m ready' }).click()
    await expect(ana.getByRole('heading', { name: 'Mahjong table' })).toBeAttached()
    await expect(ana).toHaveURL(new RegExp(`/room/${roomCode}$`, 'u'))
  } finally {
    await Promise.all([anaContext.close(), benContext.close(), coraContext.close()])
  }
})
