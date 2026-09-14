import type { PropsWithChildren } from 'react'
import { Link } from 'react-router-dom'

import { BrandMark } from './BrandMark.tsx'
import { RulesDialog } from './RulesDialog.tsx'
import styles from './AppShell.module.css'

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/" aria-label="Filipino Mahjong home">
          <BrandMark />
          <span>
            <span className={styles.brandName}>Filipino Mahjong</span>
            <span className={styles.brandTagline}>Pull up a chair</span>
          </span>
        </Link>
        <RulesDialog />
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        Built for four players, moving counterclockwise around the table.
      </footer>
    </div>
  )
}
