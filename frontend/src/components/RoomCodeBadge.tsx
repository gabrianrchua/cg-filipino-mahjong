import styles from './RoomCodeBadge.module.css'

export function RoomCodeBadge({ code }: { readonly code: string }) {
  return (
    <p className={styles.wrapper}>
      <span>Room code</span>
      <strong aria-label={`Room code ${Array.from(code).join(' ')}`}>{code}</strong>
    </p>
  )
}
