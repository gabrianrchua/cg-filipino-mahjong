import { useState, type PropsWithChildren } from 'react'
import { PlaySettingsTarget } from './playSettingsTarget.ts'
import { Link } from 'react-router-dom'

import { BrandMark } from './BrandMark.tsx'
import { RulesDialog } from './RulesDialog.tsx'
import { ShareRoomLink } from './ShareRoomLink.tsx'
import { SpectatorCount } from './SpectatorCount.tsx'
import styles from './AppShell.module.css'

export function AppShell({ children, roomCode, spectatorCount, playRoomCode }: PropsWithChildren<{
  readonly roomCode?: string
  readonly spectatorCount?: number
  readonly playRoomCode?: string
}>) {
  const [settingsTarget, setSettingsTarget] = useState<HTMLSpanElement | null>(null)
  return (
    <PlaySettingsTarget.Provider value={settingsTarget}>
    <div className={`${styles.app} ${roomCode ? styles.room : ''} ${playRoomCode ? styles.play : ''}`}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/" aria-label="Filipino Mahjong home">
          <BrandMark />
          <span className={styles.brandName}>Filipino Mahjong</span>
        </Link>
        <div className={styles.actions}>
          {roomCode ? <>
            <strong className={styles.roomCode} aria-label={`Room code ${Array.from(roomCode).join(' ')}`}>{roomCode}</strong>
            <ShareRoomLink compact roomCode={roomCode} />
            {spectatorCount !== undefined ? <SpectatorCount count={spectatorCount} /> : null}
          </> : null}
          {playRoomCode ? <span ref={setSettingsTarget} /> : null}
          <RulesDialog compact={Boolean(roomCode || playRoomCode)} />
        </div>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
    </PlaySettingsTarget.Provider>
  )
}
