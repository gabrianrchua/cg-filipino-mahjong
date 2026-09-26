import type { PropsWithChildren } from 'react'
import { Link } from 'react-router-dom'

import { BrandMark } from './BrandMark.tsx'
import { RulesDialog } from './RulesDialog.tsx'
import { ShareRoomLink } from './ShareRoomLink.tsx'
import styles from './AppShell.module.css'

export function AppShell({ children, playRoomCode }: PropsWithChildren<{ readonly playRoomCode?: string }>) {
  return (
    <div className={`${styles.app} ${playRoomCode ? styles.play : ''}`}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/" aria-label="Filipino Mahjong home">
          <BrandMark />
          <span className={styles.brandName}>Filipino Mahjong</span>
        </Link>
        <div className={styles.actions}>
          {playRoomCode ? <>
            <strong className={styles.roomCode} aria-label={`Room code ${Array.from(playRoomCode).join(' ')}`}>{playRoomCode}</strong>
            <ShareRoomLink compact roomCode={playRoomCode} />
          </> : null}
          <RulesDialog compact={Boolean(playRoomCode)} />
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  )
}
