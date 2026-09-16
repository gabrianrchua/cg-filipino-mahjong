import { RoomCodeSchema, type LobbySummary, type Visibility } from '@cg-filipino-mahjong/shared'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button } from '../components/Button.tsx'
import { GuestNameForm } from '../components/GuestNameForm.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import styles from './LobbyScreen.module.css'

function roomAction(room: LobbySummary): { readonly label: string; readonly disabled: boolean } {
  if (room.status === 'playing') {
    return room.takeoverSeatCount > 0
      ? { label: 'Take over a bot', disabled: false }
      : { label: 'Game in progress', disabled: true }
  }
  if (room.availableSeatCount > 0) return { label: 'Join room', disabled: false }
  if (room.takeoverSeatCount > 0) return { label: 'Choose a bot seat', disabled: false }
  return { label: 'Room full', disabled: true }
}

function statusLabel(status: LobbySummary['status']): string {
  if (status === 'between-hands') return 'Between hands'
  return status === 'playing' ? 'Playing' : 'Waiting'
}

export function LobbyScreen() {
  const navigate = useNavigate()
  const roomCodeId = useId()
  const roomCodeErrorId = useId()
  const [roomCode, setRoomCode] = useState('')
  const [roomCodeError, setRoomCodeError] = useState('')
  const [createError, setCreateError] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('public')
  const { clearDeparture, clearIssue, resynchronize, sendCommand } = useRealtimeActions()
  const state = useRealtimeState()
  const { connectionStatus, departure, hasReceivedLobby, lobbyRooms, pendingCommands, roomError, roomSnapshot, sessionStatus } = state
  const createPending = Object.values(pendingCommands).some((pending) => pending.type === 'room.create')
  const entryPending = Object.values(pendingCommands).some((pending) => pending.type === 'room.join' || pending.type === 'room.takeover')
  const commandsDisabled = connectionStatus !== 'connected' || createPending || entryPending

  useEffect(() => {
    if (roomSnapshot) navigate(`/room/${roomSnapshot.roomCode}`, { replace: true })
  }, [navigate, roomSnapshot])

  useEffect(() => {
    if (departure?.status === 'detached' && !roomSnapshot) clearDeparture()
  }, [clearDeparture, departure, roomSnapshot])

  useEffect(() => {
    if (roomError) clearIssue()
  }, [clearIssue, roomError])

  const joinByCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = RoomCodeSchema.safeParse(roomCode)
    if (!parsed.success) {
      setRoomCodeError('Enter the six-character code from your invitation.')
      return
    }
    setRoomCodeError('')
    navigate(`/room/${parsed.data}`)
  }

  const createRoom = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreateError('')
    try {
      const acknowledgement = await sendCommand({ type: 'room.create', visibility })
      if (acknowledgement.status === 'rejected') setCreateError(acknowledgement.error.message)
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : 'The room could not be created.')
    }
  }

  if (sessionStatus === 'anonymous') {
    return (
      <ScreenFrame eyebrow="No account required" title="Pull up a chair." description="Start with a guest name, then create a room or find an open table.">
        <GuestNameForm />
      </ScreenFrame>
    )
  }

  if (sessionStatus === 'restoring' || (sessionStatus === 'ready' && !hasReceivedLobby && !roomSnapshot)) {
    return (
      <ScreenFrame eyebrow="Connecting" title="Finding your table…" description="Restoring your guest session and the latest room list.">
        {connectionStatus === 'disconnected' ? <Button onClick={resynchronize}>Reconnect</Button> : <p role="status">Loading lobby…</p>}
      </ScreenFrame>
    )
  }

  if (sessionStatus === 'superseded') {
    return <ScreenFrame eyebrow="Session moved" title="This guest is active in another tab." description="Use the newer tab to keep playing. Reload here only if that tab is no longer available." />
  }

  return (
    <ScreenFrame
      eyebrow="Guest lobby"
      title="Mahjong, made for the whole table."
      description="Create a table, enter an invitation code, or join a public room. Every seated human has equal control."
    >
      {connectionStatus === 'disconnected' ? (
        <div className={styles.connection} role="alert"><span>Connection lost. Room actions are unavailable.</span><Button variant="secondary" onClick={resynchronize}>Reconnect</Button></div>
      ) : null}

      <div className={styles.actionsGrid}>
        <form className={styles.card} onSubmit={(event) => void createRoom(event)}>
          <div><p className={styles.kicker}>Start a table</p><h2>Create a room</h2></div>
          <fieldset className={styles.visibility}>
            <legend>Who can discover it?</legend>
            <label><input type="radio" name="visibility" value="public" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> <span><strong>Public</strong><small>Shown in the live room list.</small></span></label>
            <label><input type="radio" name="visibility" value="unlisted" checked={visibility === 'unlisted'} onChange={() => setVisibility('unlisted')} /> <span><strong>Unlisted</strong><small>Available only through its code or link.</small></span></label>
          </fieldset>
          <Button type="submit" disabled={commandsDisabled}>{createPending ? 'Creating…' : 'Create room'}</Button>
          {createError ? <p className={styles.error} role="alert">{createError}</p> : null}
        </form>

        <form className={styles.card} onSubmit={joinByCode} noValidate>
          <div><p className={styles.kicker}>Have an invitation?</p><h2>Join by room code</h2><p className={styles.help}>Spaces and letter case are normalized.</p></div>
          <div className={styles.field}>
            <label htmlFor={roomCodeId}>Room code</label>
            <input
              id={roomCodeId}
              name="roomCode"
              value={roomCode}
              onChange={(event) => { setRoomCode(event.target.value.toUpperCase()); if (roomCodeError) setRoomCodeError('') }}
              aria-describedby={roomCodeError ? roomCodeErrorId : undefined}
              aria-invalid={Boolean(roomCodeError)}
              autoComplete="off"
              autoCapitalize="characters"
              inputMode="text"
              enterKeyHint="go"
              placeholder="MJ2345"
            />
            {roomCodeError ? <p className={styles.error} id={roomCodeErrorId} role="alert">{roomCodeError}</p> : null}
          </div>
          <Button type="submit" disabled={commandsDisabled}>Check room</Button>
        </form>
      </div>

      <section className={styles.discovery} aria-labelledby="public-rooms-title">
        <div className={styles.discoveryHeading}><div><p className={styles.kicker}>Live discovery</p><h2 id="public-rooms-title">Public rooms</h2></div><span aria-live="polite">{lobbyRooms.length} {lobbyRooms.length === 1 ? 'room' : 'rooms'}</span></div>
        {lobbyRooms.length === 0 ? (
          <div className={styles.empty}><h3>No public rooms yet.</h3><p>Create one above, or enter a code for an unlisted table.</p></div>
        ) : (
          <div className={styles.roomList}>
            {lobbyRooms.map((room) => {
              const action = roomAction(room)
              return (
                <article className={styles.room} key={room.roomId}>
                  <div><strong className={styles.code}>{room.roomCode}</strong><span className={styles.status}>{statusLabel(room.status)}{room.isPaused ? ' · Paused' : ''}</span></div>
                  <dl><div><dt>Humans</dt><dd>{room.humanCount}/4</dd></div><div><dt>Open seats</dt><dd>{room.availableSeatCount}</dd></div><div><dt>Bot takeovers</dt><dd>{room.takeoverSeatCount}</dd></div></dl>
                  <Button disabled={commandsDisabled || action.disabled} onClick={() => navigate(`/room/${room.roomCode}`)}>{action.label}</Button>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </ScreenFrame>
  )
}
