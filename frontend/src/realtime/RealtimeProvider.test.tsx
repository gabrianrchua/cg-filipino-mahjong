/* oxlint-disable react/globals -- The probe intentionally captures context values for black-box assertions. */

import {
  ACTIVE_LOCAL_TURN_FIXTURE,
  ROOM_ENTRY_FIXTURE,
  WAITING_ROOM_FIXTURE,
  type CommandAcknowledgement,
} from '@cg-filipino-mahjong/shared'
import { StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  RECONNECT_CREDENTIAL_STORAGE_KEY,
  RealtimeCommandError,
  RealtimeProvider,
  useRealtimeActions,
  useRealtimeState,
  type RealtimeActions,
} from './RealtimeProvider.tsx'
import type { RealtimeState } from './state.ts'
import { HAND_ORDER_STORAGE_KEY } from './handArrangement.ts'

const commandId = '20000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000002'
const credential = 'reconnect_credential_that_is_long_enough_1234567890'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

class FakeSocket {
  connected = false
  connectCalls = 0
  disconnectCalls = 0
  readonly listeners = new Map<string, Set<(value: never) => void>>()
  readonly commands: Array<{
    command: Record<string, unknown>
    acknowledge: (value: unknown) => void
  }> = []
  readonly volatile = {
    emit: (_event: string, command: Record<string, unknown>, acknowledge: (value: unknown) => void) => {
      this.commands.push({ command, acknowledge })
    },
  }

  on(event: string, listener: (value: never) => void) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }

  off(event: string, listener: (value: never) => void) {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  connect() {
    this.connectCalls += 1
    this.connected = true
    this.serverEmit('connect', undefined)
    return this
  }

  disconnect() {
    this.disconnectCalls += 1
    if (this.connected) {
      this.connected = false
      this.serverEmit('disconnect', 'io client disconnect')
    }
    return this
  }

  serverEmit(event: string, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never)
  }
}

interface MountedProvider {
  readonly socket: FakeSocket
  readonly getAuth: () => Record<string, unknown>
  readonly getState: () => RealtimeState
  readonly getActions: () => RealtimeActions
  readonly renderer: ReactTestRenderer
}

function mountProvider(storage: MemoryStorage, strict = false, handOrderStorage?: MemoryStorage): MountedProvider {
  const socket = new FakeSocket()
  let auth = () => ({}) as Record<string, unknown>
  let state!: RealtimeState
  let actions!: RealtimeActions
  function Probe() {
    state = useRealtimeState()
    actions = useRealtimeActions()
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    const provider = (
      <RealtimeProvider
        storage={storage}
        handOrderStorage={handOrderStorage}
        socketFactory={(getAuth) => {
          auth = getAuth
          return socket as never
        }}
        createCommandId={() => commandId}
      >
        <Probe />
      </RealtimeProvider>
    )
    renderer = create(strict ? <StrictMode>{provider}</StrictMode> : provider)
  })
  return { socket, getAuth: () => auth(), getState: () => state, getActions: () => actions, renderer }
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('realtime provider', () => {
  it('restores a stored credential through handshake auth and cleans up Strict Mode listeners', () => {
    const storage = new MemoryStorage()
    storage.setItem(RECONNECT_CREDENTIAL_STORAGE_KEY, credential)
    const mounted = mountProvider(storage, true)

    expect(mounted.getAuth()).toEqual({ reconnectCredential: credential })
    expect(mounted.socket.connectCalls).toBeGreaterThanOrEqual(2)
    for (const listeners of mounted.socket.listeners.values()) expect(listeners.size).toBe(1)
    act(() => {
      mounted.socket.serverEmit('session.ready', { sessionId, resumed: true })
      mounted.socket.serverEmit('room.snapshot', ACTIVE_LOCAL_TURN_FIXTURE)
    })
    expect(mounted.getState()).toMatchObject({ sessionStatus: 'ready', resumed: true })
    expect(mounted.getState().roomSnapshot).toEqual(ACTIVE_LOCAL_TURN_FIXTURE)

    act(() => mounted.renderer.unmount())
    for (const listeners of mounted.socket.listeners.values()) expect(listeners.size).toBe(0)
  })

  it('persists a bootstrapped credential for a later provider reload', async () => {
    const storage = new MemoryStorage()
    const mounted = mountProvider(storage)
    let result!: Promise<CommandAcknowledgement>
    act(() => {
      result = mounted.getActions().bootstrapSession('Ana')
    })
    expect(mounted.socket.commands[0]?.command).toEqual({
      commandId,
      type: 'session.bootstrap',
      displayName: 'Ana',
    })
    await act(async () => {
      mounted.socket.commands[0]!.acknowledge({
        commandId,
        status: 'accepted',
        duplicate: false,
        result: { kind: 'session-bootstrapped', sessionId, reconnectCredential: credential },
      })
      await result
    })
    expect(storage.getItem(RECONNECT_CREDENTIAL_STORAGE_KEY)).toBe(credential)
    act(() => mounted.renderer.unmount())

    const reloaded = mountProvider(storage)
    expect(reloaded.getAuth()).toEqual({ reconnectCredential: credential })
    act(() => reloaded.renderer.unmount())
  })

  it('restores and persists session-local physical tile order without selection', () => {
    if (ACTIVE_LOCAL_TURN_FIXTURE.stage !== 'playing') throw new Error('Expected an active fixture')
    const handOrderStorage = new MemoryStorage()
    const identity = `${ACTIVE_LOCAL_TURN_FIXTURE.roomId}:${ACTIVE_LOCAL_TURN_FIXTURE.handId}:0`
    const original = ACTIVE_LOCAL_TURN_FIXTURE.privateState!.concealedTiles.map((tile) => tile.tileId)
    const restored = [...original].reverse()
    handOrderStorage.setItem(HAND_ORDER_STORAGE_KEY, JSON.stringify({ identity, tileOrder: restored }))
    const mounted = mountProvider(new MemoryStorage(), false, handOrderStorage)

    act(() => {
      mounted.socket.serverEmit('session.ready', { sessionId, resumed: true })
      mounted.socket.serverEmit('room.snapshot', ACTIVE_LOCAL_TURN_FIXTURE)
    })
    expect(mounted.getState().localHand).toEqual({ identity, tileOrder: restored, selectedTileId: null })

    const nextOrder = [restored[1]!, restored[0]!, restored[2]!]
    act(() => mounted.getActions().setTileOrder(nextOrder))
    expect(JSON.parse(handOrderStorage.getItem(HAND_ORDER_STORAGE_KEY)!)).toEqual({ identity, tileOrder: nextOrder })
    expect(handOrderStorage.getItem(HAND_ORDER_STORAGE_KEY)).not.toContain('selectedTileId')

    act(() => mounted.renderer.unmount())
  })

  it('returns a typed safe room inspection result', async () => {
    const mounted = mountProvider(new MemoryStorage())
    act(() => mounted.socket.serverEmit('session.ready', { sessionId, resumed: false }))
    let inspection!: ReturnType<RealtimeActions['inspectRoom']>
    act(() => { inspection = mounted.getActions().inspectRoom('MJ2345') })
    expect(mounted.socket.commands[0]?.command).toEqual({
      commandId,
      type: 'room.inspect',
      roomCode: 'MJ2345',
    })
    await act(async () => {
      mounted.socket.commands[0]!.acknowledge({
        commandId,
        status: 'accepted',
        duplicate: false,
        result: { kind: 'room-entry', entry: ROOM_ENTRY_FIXTURE },
      })
      await expect(inspection).resolves.toEqual(ROOM_ENTRY_FIXTURE)
    })
    act(() => mounted.renderer.unmount())
  })

  it('times out a lost acknowledgement, resynchronizes, and never replays the move', async () => {
    vi.useFakeTimers()
    const mounted = mountProvider(new MemoryStorage())
    act(() => {
      mounted.socket.serverEmit('session.ready', { sessionId, resumed: false })
      mounted.socket.serverEmit('room.snapshot', ACTIVE_LOCAL_TURN_FIXTURE)
    })
    const choiceId = ACTIVE_LOCAL_TURN_FIXTURE.stage === 'playing'
      ? ACTIVE_LOCAL_TURN_FIXTURE.privateState!.legalChoices[0]!.choiceId
      : commandId
    let submission!: Promise<CommandAcknowledgement>
    act(() => {
      submission = mounted.getActions().submitGameplayChoice(choiceId)
    })
    expect(mounted.socket.commands).toHaveLength(1)
    const rejection = expect(submission).rejects.toMatchObject({
      issue: { code: 'acknowledgement-timeout', commandId },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
    })
    expect(mounted.socket.commands).toHaveLength(1)
    expect(mounted.socket.connectCalls).toBe(2)
    expect(mounted.getState().pendingCommands).toEqual({})
    act(() => mounted.renderer.unmount())
  })

  it('submits one leave, keeps state on rejection, and retires only a confirmed detached room', async () => {
    const mounted = mountProvider(new MemoryStorage())
    act(() => {
      mounted.socket.serverEmit('session.ready', { sessionId, resumed: false })
      mounted.socket.serverEmit('room.snapshot', WAITING_ROOM_FIXTURE)
    })
    let leave!: Promise<CommandAcknowledgement>
    act(() => { leave = mounted.getActions().sendCommand({ type: 'room.leave', roomId: WAITING_ROOM_FIXTURE.roomId }) })
    let duplicate!: Promise<CommandAcknowledgement>
    act(() => { duplicate = mounted.getActions().sendCommand({ type: 'room.leave', roomId: WAITING_ROOM_FIXTURE.roomId }) })
    await expect(duplicate).rejects.toMatchObject({ issue: { code: 'departure-pending' } })
    expect(mounted.socket.commands).toHaveLength(1)
    await act(async () => {
      mounted.socket.commands[0]!.acknowledge({
        commandId, status: 'rejected', duplicate: false,
        error: { code: 'invalid-room-state', message: 'Cannot leave now.' },
      })
      await leave
    })
    expect(mounted.getState().roomSnapshot).toEqual(WAITING_ROOM_FIXTURE)

    act(() => { leave = mounted.getActions().sendCommand({ type: 'room.leave', roomId: WAITING_ROOM_FIXTURE.roomId }) })
    await act(async () => {
      mounted.socket.commands[1]!.acknowledge({
        commandId, status: 'accepted', duplicate: false,
        result: { kind: 'room-departure', disposition: 'detached', roomRevision: WAITING_ROOM_FIXTURE.roomRevision + 1 },
      })
      await leave
    })
    expect(mounted.getState().roomSnapshot).toBeNull()
    act(() => mounted.socket.serverEmit('room.snapshot', WAITING_ROOM_FIXTURE))
    expect(mounted.getState().roomSnapshot).toBeNull()
    act(() => mounted.renderer.unmount())
  })

  it('reconciles a timed-out leave from the restored lobby without a replacement guest', async () => {
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    storage.setItem(RECONNECT_CREDENTIAL_STORAGE_KEY, credential)
    const mounted = mountProvider(storage)
    act(() => {
      mounted.socket.serverEmit('session.ready', { sessionId, resumed: true })
      mounted.socket.serverEmit('room.snapshot', WAITING_ROOM_FIXTURE)
    })
    let leave!: Promise<CommandAcknowledgement>
    act(() => { leave = mounted.getActions().sendCommand({ type: 'room.leave', roomId: WAITING_ROOM_FIXTURE.roomId }) })
    const rejection = expect(leave).rejects.toMatchObject({ issue: { code: 'acknowledgement-timeout' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); await rejection })
    expect(mounted.getState().departure?.status).toBe('uncertain')
    act(() => {
      mounted.socket.serverEmit('session.ready', { sessionId, resumed: true })
      mounted.socket.serverEmit('lobby.updated', { rooms: [] })
    })
    expect(mounted.getState().departure?.status).toBe('detached')
    expect(mounted.getState().roomSnapshot).toBeNull()
    expect(storage.getItem(RECONNECT_CREDENTIAL_STORAGE_KEY)).toBe(credential)
    expect(mounted.socket.commands).toHaveLength(1)
    act(() => mounted.renderer.unmount())
  })

  it('clears an invalid stored credential once and reconnects anonymously', () => {
    const storage = new MemoryStorage()
    storage.setItem(RECONNECT_CREDENTIAL_STORAGE_KEY, credential)
    const mounted = mountProvider(storage)
    const error = Object.assign(new Error('Invalid session'), {
      data: { code: 'invalid-session', message: 'The session is invalid.' },
    })
    act(() => mounted.socket.serverEmit('connect_error', error))
    expect(storage.getItem(RECONNECT_CREDENTIAL_STORAGE_KEY)).toBeNull()
    expect(mounted.getAuth()).toEqual({})
    expect(mounted.getState().sessionStatus).toBe('anonymous')
    expect(mounted.socket.connectCalls).toBe(2)
    act(() => mounted.renderer.unmount())
  })

  it('locks a superseded provider without erasing the shared credential', async () => {
    const storage = new MemoryStorage()
    storage.setItem(RECONNECT_CREDENTIAL_STORAGE_KEY, credential)
    const mounted = mountProvider(storage)
    act(() => mounted.socket.serverEmit('session.superseded', { reason: 'newer-connection' }))
    expect(mounted.getState()).toMatchObject({ connectionStatus: 'superseded', sessionStatus: 'superseded' })
    expect(storage.getItem(RECONNECT_CREDENTIAL_STORAGE_KEY)).toBe(credential)
    await expect(mounted.getActions().sendCommand({ type: 'lobby.list' }))
      .rejects.toBeInstanceOf(RealtimeCommandError)
    expect(mounted.socket.commands).toHaveLength(0)
    act(() => mounted.renderer.unmount())
  })
})
