import { DisplayNameSchema } from '@cg-filipino-mahjong/shared'
import { useId, useState, type FormEvent } from 'react'

import { useRealtimeActions, useRealtimeState } from '../realtime/RealtimeProvider.tsx'
import { Button } from './Button.tsx'
import styles from './GuestNameForm.module.css'

export function GuestNameForm() {
  const inputId = useId()
  const errorId = useId()
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const { bootstrapSession, resynchronize } = useRealtimeActions()
  const { connectionStatus, pendingCommands } = useRealtimeState()
  const isPending = Object.values(pendingCommands).some((pending) => pending.type === 'session.bootstrap')
  const canSubmit = connectionStatus === 'connected' && !isPending

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = DisplayNameSchema.safeParse(displayName)
    if (!parsed.success) {
      setError('Enter a name between 1 and 24 characters without control characters.')
      return
    }
    setError('')
    try {
      const acknowledgement = await bootstrapSession(parsed.data)
      if (acknowledgement.status === 'rejected') setError(acknowledgement.error.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The guest session could not be created.')
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.field}>
        <label htmlFor={inputId}>Display name</label>
        <input
          id={inputId}
          name="displayName"
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value)
            if (error) setError('')
          }}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          autoComplete="nickname"
          maxLength={48}
          enterKeyHint="go"
          disabled={isPending}
          autoFocus
        />
        {error ? <p className={styles.error} id={errorId} role="alert">{error}</p> : null}
      </div>
      {connectionStatus === 'disconnected' ? (
        <Button type="button" variant="secondary" onClick={resynchronize}>Reconnect</Button>
      ) : (
        <Button type="submit" disabled={!canSubmit}>{isPending ? 'Joining…' : 'Continue as guest'}</Button>
      )}
    </form>
  )
}
