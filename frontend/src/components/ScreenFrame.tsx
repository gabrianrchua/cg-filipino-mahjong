import type { PropsWithChildren, ReactNode } from 'react'

import styles from './ScreenFrame.module.css'

interface ScreenFrameProps extends PropsWithChildren {
  readonly eyebrow?: string
  readonly title: string
  readonly description?: string
  readonly actions?: ReactNode
  readonly tone?: 'paper' | 'table'
  readonly playLayout?: boolean
}

export function ScreenFrame({ actions, children, description, eyebrow, title, tone = 'paper', playLayout = false }: ScreenFrameProps) {
  return (
    <section data-play-layout={playLayout || undefined} className={`${styles.screen} ${styles[tone]} ${playLayout ? styles.play : ''}`}>
      <div className={styles.inner}>
        {playLayout ? <h1 className={styles.playTitle}>{title}</h1> : <header className={styles.intro}>
          <div>
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h1>{title}</h1>
            {description ? <p className={styles.description}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>}
        {children}
      </div>
    </section>
  )
}
