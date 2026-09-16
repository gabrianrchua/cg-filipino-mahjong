import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import {
  RoomSnapshotSchema,
  type ClientCommand,
  type CommandAcknowledgement,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@cg-filipino-mahjong/shared'
import { io, type Socket } from 'socket.io-client'

type TestSocket = Socket<ServerToClientEvents, { command: (
  command: ClientCommand,
  acknowledge: (result: CommandAcknowledgement) => void,
) => void }>

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
        // Engine.IO control frames and partial frames are not application events.
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

async function joinRoom(page: Page, roomCode: string): Promise<void> {
  await page.goto(`/room/${roomCode}`)
  await expect(page.getByRole('heading', { name: 'Choose how to join.' })).toBeVisible()
  await page.getByRole('button', { name: 'Join an open seat' }).click()
  await expect(page.getByRole('heading', { name: 'The table is almost ready.' })).toBeVisible()
}

async function submitChoice(page: Page, name: RegExp, submitName: string): Promise<void> {
  const actions = page.getByTestId('gameplay-actions')
  await actions.getByRole('radio', { name }).check()
  await actions.getByRole('button', { name: submitName }).click()
}

function latestPlaying(captured: CapturedSnapshots): Extract<RoomSnapshot, { stage: 'playing' }> {
  const snapshot = captured.snapshots.findLast((candidate) => candidate.stage === 'playing')
  if (!snapshot || snapshot.stage !== 'playing') throw new Error('Expected a captured active-game snapshot.')
  return snapshot
}

function connectSocket(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = io('http://localhost:5173', {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    }) as TestSocket
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function socketCommand(socket: TestSocket, command: ClientCommand): Promise<CommandAcknowledgement> {
  return new Promise((resolve) => socket.emit('command', command, resolve))
}

function nextSocketSnapshot(socket: TestSocket): Promise<RoomSnapshot> {
  return new Promise((resolve) => socket.once('room.snapshot', resolve))
}

function nextMatchingSocketSnapshot(
  socket: TestSocket,
  predicate: (snapshot: RoomSnapshot) => boolean,
): Promise<RoomSnapshot> {
  return new Promise((resolve) => {
    const listener = (snapshot: RoomSnapshot) => {
      if (!predicate(snapshot)) return
      socket.off('room.snapshot', listener)
      resolve(snapshot)
    }
    socket.on('room.snapshot', listener)
  })
}

const commandId = (suffix: number) => `70000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`

test('resolves competing private claims and completes two successive hands', async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()))
  const pages = await Promise.all(contexts.map((context) => context.newPage()))
  const captures = pages.map(captureSnapshots)
  const [ana, ben, cora, dan] = pages

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
    await joinRoom(cora, roomCode)
    await joinRoom(dan, roomCode)

    await Promise.all(pages.map((page) => page.getByRole('button', { name: 'I’m ready' }).click()))
    await Promise.all(pages.map((page) => expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()))

    const initial = captures.map(latestPlaying)
    const privateTileIds = initial.map((snapshot) => new Set(
      snapshot.privateState?.concealedTiles.map((tile) => tile.tileId) ?? [],
    ))
    for (let left = 0; left < privateTileIds.length; left += 1) {
      for (let right = left + 1; right < privateTileIds.length; right += 1) {
        expect([...privateTileIds[left]!].some((tileId) => privateTileIds[right]!.has(tileId))).toBe(false)
      }
    }

    const ownerSecret = initial[2]!.seats[2]!.melds.find((meld) => meld.kind === 'secret')
    expect(ownerSecret).toMatchObject({ kind: 'secret', visibility: 'owner' })
    if (!ownerSecret || !('tiles' in ownerSecret)) throw new Error('Expected the secret owner projection.')
    const secretIds = ownerSecret.tiles.map((tile) => tile.tileId)
    for (const [index, snapshot] of initial.entries()) {
      if (index === 2) continue
      expect(snapshot.seats[2]!.melds).toContainEqual(expect.objectContaining({
        kind: 'secret', visibility: 'masked', tileCount: 4,
      }))
      for (const tileId of secretIds) expect(JSON.stringify(snapshot)).not.toContain(tileId)
    }

    const discardTile = ana.locator('[data-hand-tile-id="suited-characters-9-1"]')
    await discardTile.getByRole('button', { name: /Select Nine of characters/u }).click()
    await ana.getByRole('button', { name: 'Discard selected tile' }).click()
    await Promise.all([ben, cora, dan].map((page) => expect(page.getByText('0 of 3 responded')).toBeVisible()))

    await submitChoice(dan, /Win/u, 'Declare win')
    await expect(dan.getByText('Response received. Waiting for the other opponents.')).toBeVisible()
    await expect(ana.getByText('1 of 3 responded')).toBeVisible()
    await expect.poll(() => {
      const snapshot = captures[0]!.snapshots.findLast((candidate) => candidate.stage === 'playing')
      return snapshot?.stage === 'playing' && snapshot.phase.kind === 'discard-responses'
        ? snapshot.phase.respondedSeats
        : []
    }).toEqual([3])
    const pending = latestPlaying(captures[0]!)
    expect(pending.phase).toMatchObject({ kind: 'discard-responses', respondedSeats: [3] })
    expect(pending).not.toHaveProperty('responses')

    await submitChoice(cora, /Pass/u, 'Submit pass')
    await submitChoice(ben, /Win/u, 'Declare win')

    await Promise.all(pages.map((page) => expect(page.getByRole('heading', { name: 'Ready for another hand?' })).toBeVisible()))
    await Promise.all(pages.map((page) => expect(page.getByRole('heading', { name: 'Ben wins on a discard.' })).toBeVisible()))
    await expect(ana.getByText('0 of 4 humans ready.')).toBeVisible()

    await Promise.all(pages.map((page) => page.getByRole('button', { name: 'I’m ready' }).click()))
    await Promise.all(pages.map((page) => expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()))
    await submitChoice(ben, /Win/u, 'Declare win')
    await Promise.all(pages.map((page) => expect(page.getByRole('heading', { name: 'Ben wins by self-draw.' })).toBeVisible()))
    await expect(ben.getByText('0 of 4 humans ready.')).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})

test('restores an active private hand after closing and refreshing the browser', async ({ browser }) => {
  const context = await browser.newContext()
  let page = await context.newPage()
  try {
    await bootstrapGuest(page, 'Ana')
    await page.getByRole('button', { name: 'Create room' }).click()
    const roomUrl = page.url()
    for (let index = 0; index < 3; index += 1) {
      await page.getByRole('button', { name: 'Add bot' }).first().click()
      await expect(page.getByRole('heading', { name: 'Bot player', exact: true })).toHaveCount(index + 1)
    }
    await page.getByRole('button', { name: 'I’m ready' }).click()
    await expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()
    await page.close()

    page = await context.newPage()
    await page.goto(roomUrl)
    await expect(page.getByRole('heading', { name: 'Everything has its place.' })).toBeVisible()
    await expect(page.locator('[data-hand-tile-id]')).toHaveCount(17)
    await page.reload()
    await expect(page.locator('[data-hand-tile-id]')).toHaveCount(17)

    const discardTile = page.locator('[data-hand-tile-id="suited-characters-9-1"]')
    await discardTile.getByRole('button', { name: /Select Nine of characters/u }).click()
    await page.getByRole('button', { name: 'Discard selected tile' }).click()
    await expect(page.getByLabel('Nine of characters, latest discard')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('deduplicates commands and safely rejects a command from a resolved phase', async () => {
  const sockets = await Promise.all(Array.from({ length: 4 }, () => connectSocket()))
  const ana = sockets[0]!
  try {
    await Promise.all(sockets.map((socket, index) => socketCommand(socket, {
      commandId: commandId(100 + index),
      type: 'session.bootstrap',
      displayName: ['Ana', 'Ben', 'Cora', 'Dan'][index]!,
    })))
    const createdEvent = nextSocketSnapshot(ana)
    await socketCommand(ana, { commandId: commandId(110), type: 'room.create', visibility: 'public' })
    let room = await createdEvent
    for (const [index, socket] of sockets.slice(1).entries()) {
      const changed = nextSocketSnapshot(ana)
      await socketCommand(socket, {
        commandId: commandId(111 + index), type: 'room.join', roomCode: room.roomCode,
      })
      room = await changed
    }
    for (const [index, socket] of sockets.entries()) {
      const changed = nextSocketSnapshot(ana)
      await socketCommand(socket, {
        commandId: commandId(120 + index), type: 'room.set-ready',
        roomId: room.roomId, readinessId: room.readinessId, ready: true,
      })
      room = await changed
    }
    if (room.stage !== 'playing' || !room.privateState) throw new Error('Expected an active room.')
    const discard = room.privateState.legalChoices.find((choice) => (
      choice.kind === 'discard' && choice.tileId === 'suited-characters-9-1'
    ))
    if (!discard) throw new Error('Expected the deterministic discard.')
    const action: ClientCommand = {
      commandId: commandId(130), type: 'game.action', roomId: room.roomId,
      handId: room.handId, phaseId: room.phase.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    }
    const responseViews = sockets.map((socket) => nextMatchingSocketSnapshot(socket, (snapshot) => (
      snapshot.stage === 'playing' && snapshot.phase.kind === 'discard-responses'
    )))
    expect(await socketCommand(ana, action)).toMatchObject({ status: 'accepted', duplicate: false })
    const duplicate = await socketCommand(ana, action)
    expect(duplicate).toMatchObject({ status: 'accepted', duplicate: true })
    const conflict = await socketCommand(ana, {
      ...action,
      action: { kind: 'win', choiceId: discard.choiceId },
    })
    expect(conflict).toMatchObject({ status: 'rejected', error: { code: 'command-conflict' } })

    const responseSnapshots = await Promise.all(responseViews)
    for (const [index, socket] of sockets.slice(1).entries()) {
      const snapshot = responseSnapshots[index + 1]!
      if (snapshot.stage !== 'playing' || !snapshot.privateState) throw new Error('Expected response choices.')
      const pass = snapshot.privateState.legalChoices.find((choice) => choice.kind === 'pass')
      if (!pass) throw new Error('Expected pass.')
      await socketCommand(socket, {
        commandId: commandId(140 + index), type: 'game.action', roomId: snapshot.roomId,
        handId: snapshot.handId, phaseId: snapshot.phase.phaseId,
        action: { kind: 'respond-to-discard', choiceId: pass.choiceId },
      })
    }

    const stale = await socketCommand(ana, { ...action, commandId: commandId(150) })
    expect(stale).toMatchObject({
      status: 'rejected', duplicate: false, error: { code: 'stale-phase' },
      snapshot: { stage: 'playing' },
    })
  } finally {
    for (const socket of sockets) socket.disconnect()
  }
})

test('defers bot takeover without exposing private state until claims resolve', async ({ page }) => {
  const captured = captureSnapshots(page)
  const host = await connectSocket()
  try {
    await socketCommand(host, {
      commandId: commandId(200), type: 'session.bootstrap', displayName: 'Host',
    })
    const createdEvent = nextSocketSnapshot(host)
    await socketCommand(host, { commandId: commandId(201), type: 'room.create', visibility: 'public' })
    let room = await createdEvent
    for (const [index, seat] of ([1, 2, 3] as const).entries()) {
      const changed = nextSocketSnapshot(host)
      await socketCommand(host, {
        commandId: commandId(202 + index), type: 'room.configure-seat', roomId: room.roomId,
        expectedRoomRevision: room.roomRevision, seat, controller: 'bot',
      })
      room = await changed
    }
    const playingEvent = nextSocketSnapshot(host)
    await socketCommand(host, {
      commandId: commandId(205), type: 'room.set-ready', roomId: room.roomId,
      readinessId: room.readinessId, ready: true,
    })
    room = await playingEvent
    if (room.stage !== 'playing' || !room.privateState) throw new Error('Expected active play.')

    await bootstrapGuest(page, 'Takeover Guest')
    const discard = room.privateState.legalChoices.find((choice) => (
      choice.kind === 'discard' && choice.tileId === 'suited-characters-9-1'
    ))
    if (!discard) throw new Error('Expected deterministic discard.')
    await socketCommand(host, {
      commandId: commandId(206), type: 'game.action', roomId: room.roomId,
      handId: room.handId, phaseId: room.phase.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    })

    await page.goto(`/room/${room.roomCode}`)
    await page.getByRole('button', { name: 'Take over seat 2' }).click()
    await expect(page.getByRole('heading', { name: 'Finishing the current claims…' })).toBeVisible()
    await expect.poll(() => captured.snapshots.some((snapshot) => (
      snapshot.stage === 'playing' && snapshot.privateState === null
    ))).toBe(true)
    await expect(page.getByRole('heading', { name: 'Ready for another hand?' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Takeover Guest', exact: true })).toBeVisible()
    const admitted = captured.snapshots.findLast((snapshot) => snapshot.self.seat === 1)
    expect(admitted?.self).toEqual({ seat: 1, canControl: true })
  } finally {
    host.disconnect()
  }
})

test('offers admission again after a disconnected pending takeover is canceled', async ({ page }) => {
  const host = await connectSocket()
  const opponent = await connectSocket()
  let holdReconnect = false
  const browserSockets: WebSocketRoute[] = []
  await page.routeWebSocket(/\/socket\.io\//u, (route) => {
    browserSockets.push(route)
    if (holdReconnect) {
      void route.close()
    } else {
      route.connectToServer()
    }
  })
  try {
    await Promise.all([
      socketCommand(host, { commandId: commandId(300), type: 'session.bootstrap', displayName: 'Host' }),
      socketCommand(opponent, { commandId: commandId(301), type: 'session.bootstrap', displayName: 'Opponent' }),
    ])
    const created = nextSocketSnapshot(host)
    await socketCommand(host, { commandId: commandId(302), type: 'room.create', visibility: 'public' })
    let room = await created
    const joined = nextSocketSnapshot(host)
    await socketCommand(opponent, { commandId: commandId(303), type: 'room.join', roomCode: room.roomCode })
    room = await joined
    let opponentRoom: RoomSnapshot | null = null
    for (const [index, seat] of ([2, 3] as const).entries()) {
      const hostChanged = nextSocketSnapshot(host)
      const opponentChanged = nextSocketSnapshot(opponent)
      await socketCommand(host, {
        commandId: commandId(304 + index), type: 'room.configure-seat', roomId: room.roomId,
        expectedRoomRevision: room.roomRevision, seat, controller: 'bot',
      })
      room = await hostChanged
      opponentRoom = await opponentChanged
    }
    if (!opponentRoom || room.stage === 'playing' || opponentRoom.stage === 'playing') throw new Error('Expected waiting room snapshots.')
    const hostReady = nextSocketSnapshot(host)
    const opponentReady = nextSocketSnapshot(opponent)
    await socketCommand(host, {
      commandId: commandId(306), type: 'room.set-ready', roomId: room.roomId,
      readinessId: room.readinessId, ready: true,
    })
    room = await hostReady
    opponentRoom = await opponentReady
    if (opponentRoom.stage === 'playing') throw new Error('Expected the opponent to remain unready.')
    const playing = nextSocketSnapshot(host)
    await socketCommand(opponent, {
      commandId: commandId(307), type: 'room.set-ready', roomId: room.roomId,
      readinessId: opponentRoom.readinessId, ready: true,
    })
    room = await playing
    if (room.stage !== 'playing' || !room.privateState) throw new Error('Expected active play.')

    await bootstrapGuest(page, 'Takeover Guest')
    const discard = room.privateState.legalChoices.find((choice) => (
      choice.kind === 'discard' && choice.tileId === 'suited-characters-9-1'
    ))
    if (!discard) throw new Error('Expected deterministic discard.')
    await socketCommand(host, {
      commandId: commandId(308), type: 'game.action', roomId: room.roomId,
      handId: room.handId, phaseId: room.phase.phaseId,
      action: { kind: 'discard', choiceId: discard.choiceId },
    })
    await page.goto(`/room/${room.roomCode}`)
    await expect(page.getByRole('button', { name: 'Take over seat 3' })).toBeEnabled()
    const reserved = nextMatchingSocketSnapshot(host, (snapshot) => (
      snapshot.takeoverReservations.some((reservation) => reservation.seat === 2)
    ))
    await page.getByRole('button', { name: 'Take over seat 3' }).click()
    await expect(page.getByRole('heading', { name: 'Finishing the current claims…' })).toBeVisible()
    const pending = await reserved
    const canceled = nextMatchingSocketSnapshot(host, (snapshot) => (
      snapshot.roomRevision > pending.roomRevision && snapshot.takeoverReservations.length === 0
    ))
    holdReconnect = true
    const browserSocket = browserSockets.at(-1)
    if (!browserSocket) throw new Error('Expected the browser WebSocket route.')
    await browserSocket.close()
    await canceled

    holdReconnect = false
    await page.getByRole('button', { name: 'Reconnect' }).click()
    await expect(page.getByText('Your previous takeover request was canceled.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Take over seat 3' })).toBeEnabled()
    const reservedAgain = nextMatchingSocketSnapshot(host, (snapshot) => (
      snapshot.takeoverReservations.some((reservation) => reservation.seat === 2)
    ))
    await page.getByRole('button', { name: 'Take over seat 3' }).click()
    await reservedAgain
    await expect(page.getByRole('heading', { name: 'Finishing the current claims…' })).toBeVisible()
    await expect(page.getByText('Control transfers without revealing the bot’s hand until the server admits you.')).toBeHidden()
  } finally {
    host.disconnect()
    opponent.disconnect()
  }
})
