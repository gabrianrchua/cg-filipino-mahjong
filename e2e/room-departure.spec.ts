import { expect, test, type Page } from '@playwright/test'

const credentialKey = 'cg-filipino-mahjong.reconnectCredential.v1'

async function bootstrap(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Continue as guest' }).click()
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible()
}

async function join(page: Page, code: string): Promise<void> {
  await page.goto(`/room/${code}`)
  await expect(page.getByRole('heading', { name: 'Choose how to join.' })).toBeVisible()
  await page.getByRole('button', { name: 'Join an open seat' }).click()
  await expect(page.getByRole('heading', { name: 'The table is almost ready.' })).toBeVisible()
}

test('leaves a waiting room and joins a different table with the same guest session', async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()))
  const [ana, ben, cora] = await Promise.all(contexts.map((context) => context.newPage()))
  try {
    await Promise.all([bootstrap(ana!, 'Ana'), bootstrap(ben!, 'Ben'), bootstrap(cora!, 'Cora')])
    await cora!.getByRole('button', { name: 'Create room' }).click()
    await expect(cora!).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const otherCode = new URL(cora!.url()).pathname.split('/').at(-1)!
    await ana!.getByRole('button', { name: 'Create room' }).click()
    await expect(ana!).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const oldCode = new URL(ana!.url()).pathname.split('/').at(-1)!
    const credential = await ana!.evaluate((key) => localStorage.getItem(key), credentialKey)
    await join(ben!, oldCode)
    await ben!.getByRole('button', { name: 'I’m ready' }).click()
    await expect(ben!.getByRole('button', { name: 'Mark me not ready' })).toBeVisible()

    await ana!.getByRole('button', { name: 'Leave room' }).click()
    await expect(ana!.getByRole('heading', { name: 'Create a room' })).toBeVisible()
    await expect(ben!.getByRole('button', { name: 'I’m ready' })).toBeVisible()
    await expect(ben!.getByRole('heading', { name: 'Open seat', exact: true })).toHaveCount(3)
    await join(ana!, otherCode)
    await expect(cora!.getByRole('heading', { name: 'Ana', exact: true })).toBeVisible()
    expect(await ana!.evaluate((key) => localStorage.getItem(key), credentialKey)).toBe(credential)
    await ana!.getByRole('button', { name: 'Leave room' }).click()
    await expect(ana!.getByRole('heading', { name: 'Create a room' })).toBeVisible()
    await join(ana!, oldCode)
    await expect(ben!.getByRole('heading', { name: 'Ana', exact: true })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('leaves a paused waiting room from its blocking dialog on a phone viewport', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 390, height: 844 } }), browser.newContext()])
  const [ana, ben] = await Promise.all(contexts.map((context) => context.newPage()))
  try {
    await Promise.all([bootstrap(ana!, 'Ana'), bootstrap(ben!, 'Ben')])
    await ana!.getByRole('button', { name: 'Create room' }).click()
    await expect(ana!).toHaveURL(/\/room\/[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/u)
    const code = new URL(ana!.url()).pathname.split('/').at(-1)!
    await join(ben!, code)
    await ben!.close()
    const dialog = ana!.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const leave = dialog.getByRole('button', { name: 'Leave room' })
    await leave.focus()
    await ana!.keyboard.press('Enter')
    await expect(ana!.getByRole('heading', { name: 'Create a room' })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
