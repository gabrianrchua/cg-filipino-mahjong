import * as Dialog from '@radix-ui/react-dialog'

import { Button } from './Button.tsx'
import styles from './RulesDialog.module.css'

export function RulesDialog({ compact = false }: { readonly compact?: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button className={`${styles.trigger} ${compact ? styles.compactTrigger : ''}`} variant="quiet" aria-label="How to play" title={compact ? 'How to play' : undefined}>
          {compact ? <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4" /><path d="M12 16h.01" /></svg> : 'How to play'}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby="rules-summary">
          <div className={styles.headingRow}>
            <div>
              <p className={styles.eyebrow}>First-release rules</p>
              <Dialog.Title className={styles.title}>A quick seat at the table</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <Button className={styles.closeIcon} variant="secondary" aria-label="Close rules"><span aria-hidden="true">×</span></Button>
            </Dialog.Close>
          </div>
          <Dialog.Description id="rules-summary" className={styles.summary}>
            Build five melds and one pair. The player to your right follows you,
            and every win or optional meld is declared explicitly.
          </Dialog.Description>
          <ol className={styles.steps}>
            <li><strong>Draw.</strong> Ordinary tiles come from the front of the wall.</li>
            <li><strong>Decide.</strong> Declare a win, secret, or sagása when offered.</li>
            <li><strong>Discard.</strong> Choose one suited tile to end your turn.</li>
            <li><strong>Respond.</strong> Opponents claim or pass before play continues.</li>
          </ol>
          <p className={styles.note}>
            Flowers are exposed and replaced automatically. This release has no
            scoring, payouts, chat, spectators, or move timer.
          </p>
          <Dialog.Close asChild><Button className={styles.done}>Got it</Button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
