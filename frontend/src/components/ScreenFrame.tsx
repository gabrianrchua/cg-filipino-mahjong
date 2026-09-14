import type { PropsWithChildren, ReactNode } from 'react'

import styles from './ScreenFrame.module.css'

interface ScreenFrameProps extends PropsWithChildren {
  readonly eyebrow?: string
  readonly title: string
  readonly description?: string
  readonly actions?: ReactNode
  readonly tone?: 'paper' | 'table'
}

export function ScreenFrame({ actions, children, description, eyebrow, title, tone = 'paper' }: ScreenFrameProps) {
  return (
    <section className={`${styles.screen} ${styles[tone]}`}>
      <div className={styles.inner}>
        <header className={styles.intro}>
          <div>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h1>{title}</h1>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
        {children}
      </div>
    </section>
  )
}
