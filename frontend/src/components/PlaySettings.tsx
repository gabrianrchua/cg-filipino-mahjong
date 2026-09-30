import { useContext } from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'

import { Button } from './Button.tsx'
import styles from './RulesDialog.module.css'
import settingsStyles from './PlaySettings.module.css'
import shellStyles from './AppShell.module.css'

import { PlaySettingsTarget } from './playSettingsTarget.ts'

export function PlaySettings({ autoSort, arranging, disabled, onSortToggle, onArrange }: {
  readonly autoSort: boolean
  readonly arranging: boolean
  readonly disabled: boolean
  readonly onSortToggle: () => void
  readonly onArrange: () => void
}) {
  const target = useContext(PlaySettingsTarget)
  if (!target) return null
  return createPortal(
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button className={shellStyles.settingsButton} variant="secondary" aria-label="Hand settings" title="Hand settings">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden="true">
            <path d="M18.70 9.23 L19.09 10.49 L21.36 10.35 L21.36 13.65 L19.09 13.51 L18.70 14.77 L18.08 15.95 L19.78 17.45 L17.45 19.78 L15.95 18.08 L14.77 18.70 L13.51 19.09 L13.65 21.36 L10.35 21.36 L10.49 19.09 L9.23 18.70 L8.05 18.08 L6.55 19.78 L4.22 17.45 L5.92 15.95 L5.30 14.77 L4.91 13.51 L2.64 13.65 L2.64 10.35 L4.91 10.49 L5.30 9.23 L5.92 8.05 L4.22 6.55 L6.55 4.22 L8.05 5.92 L9.23 5.30 L10.49 4.91 L10.35 2.64 L13.65 2.64 L13.51 4.91 L14.77 5.30 L15.95 5.92 L17.45 4.22 L19.78 6.55 L18.08 8.05 Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={`${styles.content} ${settingsStyles.content}`} aria-describedby={undefined}>
          <Dialog.Title>Hand settings</Dialog.Title>
          <label className={settingsStyles.toggle}><input type="checkbox" checked={autoSort} disabled={disabled} onChange={onSortToggle} /> Auto-sort hand</label>
          <p>Moving a tile turns auto-sort off.</p>
          <Dialog.Close asChild><Button variant="secondary" disabled={disabled} onClick={onArrange}>{arranging ? 'Finish arranging' : 'Arrange hand'}</Button></Dialog.Close>
          <Dialog.Close asChild><Button>Close settings</Button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>, target,
  )
}
