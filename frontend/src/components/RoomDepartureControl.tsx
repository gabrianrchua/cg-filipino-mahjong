import { useRef, useState } from 'react'

import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { hasPendingRoomMembershipCommand } from '../realtime/state.ts'
import { Button } from './Button.tsx'

export function RoomDepartureControl({
  roomId,
  label,
  onDetached,
  className,
}: {
  readonly roomId: string
  readonly label: 'Leave room' | 'Cancel takeover' | 'Stop spectating'
  readonly onDetached?: () => void
  readonly className?: string
}) {
  const { sendCommand } = useRealtimeActions()
  const state = useRealtimeState()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const pending = Object.values(state.pendingCommands).some((command) => (
    command.type === 'room.leave' && command.roomId === roomId
  ))
  const disabled = state.connectionStatus !== 'connected'
    || state.sessionStatus !== 'ready'
    || state.isResynchronizing
    || hasPendingRoomMembershipCommand(state.pendingCommands)
    || submitting

  const depart = async () => {
    if (inFlight.current || disabled) return
    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      const acknowledgement = await sendCommand({ type: 'room.leave', roomId })
      if (acknowledgement.status === 'rejected') {
        setError(acknowledgement.error.message)
      } else if (acknowledgement.result.kind === 'room-departure') {
        if (acknowledgement.result.disposition === 'detached') onDetached?.()
        else setError(label === 'Stop spectating'
          ? 'You are still watching this room. Try stopping again.'
          : 'The hand began before you left. Your seat remains reserved; switch tables between hands.')
      } else {
        setError('The server returned an unexpected departure result. Reconnect to check your seat.')
      }
    } catch (caught) {
      setError(caught instanceof Error
        ? `${caught.message} Your departure is unconfirmed; reconnect to check whether your room membership remains.`
        : 'Your departure is unconfirmed. Reconnect to check whether your room membership remains.')
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className={className}>
      <Button variant="secondary" disabled={disabled} onClick={() => void depart()}>
        {submitting || pending ? 'Leaving…' : label}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
