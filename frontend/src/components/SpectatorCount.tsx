import styles from './AppShell.module.css'

export function SpectatorCount({ count }: { readonly count: number }) {
  const label = `${count} ${count === 1 ? 'spectator' : 'spectators'}`
  return (
    <span className={styles.spectatorCount} role="status" aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2.5 12s3.3-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.3 6.5-9.5 6.5S2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.7" />
      </svg>
      <span>{count}</span>
    </span>
  )
}
