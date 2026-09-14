import { Link, useLocation } from 'react-router-dom'

import styles from './PreviewSwitcher.module.css'

export function PreviewSwitcher({ active }: { readonly active: 'waiting' | 'table' }) {
  const location = useLocation()
  if (!import.meta.env.DEV) return null
  return (
    <nav className={styles.preview} aria-label="Development screen preview">
      <span>Preview</span>
      <Link aria-current={active === 'waiting' ? 'page' : undefined} to={location.pathname}>Waiting</Link>
      <Link aria-current={active === 'table' ? 'page' : undefined} to={`${location.pathname}?preview=table`}>Table</Link>
    </nav>
  )
}
