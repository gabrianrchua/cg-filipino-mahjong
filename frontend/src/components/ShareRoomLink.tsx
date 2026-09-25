import { useEffect, useState } from 'react'

import { Button } from './Button.tsx'
import styles from './ShareRoomLink.module.css'

const COPIED_STATUS_DURATION_MS = 3_000

export function ShareRoomLink({ roomCode, compact = false }: { readonly roomCode: string; readonly compact?: boolean }) {
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (status !== 'Room link copied.') return

    const timeoutId = window.setTimeout(() => setStatus(''), COPIED_STATUS_DURATION_MS)
    return () => window.clearTimeout(timeoutId)
  }, [status])

  const copy = async () => {
    const link = new URL(`/room/${roomCode}`, window.location.origin).toString()
    try {
      await navigator.clipboard.writeText(link)
      setStatus('Room link copied.')
    } catch {
      setStatus(`Copy this room link: ${link}`)
    }
  }

  return (
    <span className={`${styles.wrapper} ${compact ? styles.compact : ''}`}>
      <Button variant="secondary" aria-label="Copy room link" title="Copy room link" onClick={() => void copy()}>{compact ? <span aria-hidden="true">⧉</span> : 'Copy room link'}</Button>
      <span className={styles.status} role="status" aria-live="polite">{status}</span>
    </span>
  )
}
