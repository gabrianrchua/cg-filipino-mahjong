import type { PlayerVisibleMeld } from '@cg-filipino-mahjong/shared'
import { useLayoutEffect, useRef, useState } from 'react'

import { MahjongTile, TileBack } from './MahjongTile.tsx'
import { tileLabel } from './tileLabels.ts'
import styles from './MeldList.module.css'

const MELD_LABELS: Readonly<Record<PlayerVisibleMeld['kind'], string>> = {
  chow: 'Chow', pong: 'Pong', 'open-kang': 'Open káng', secret: 'Secret', sagasa: 'Sagása',
}

function Meld({ meld }: { readonly meld: PlayerVisibleMeld }) {
  if (meld.kind === 'secret' && meld.visibility === 'masked') {
    return (
      <li className={styles.meld} data-motion-meld-id={meld.meldId} aria-label="Secret meld, four concealed tiles">
        <span className={styles.groupLabel}>Secret</span>
        <span className={styles.tileRow} aria-hidden="true">
          {Array.from({ length: meld.tileCount }, (_, index) => <TileBack compact key={`masked-${index}`} />)}
        </span>
      </li>
    )
  }
  const labels = meld.tiles.map(tileLabel).join(', ')
  return (
    <li className={styles.meld} data-motion-meld-id={meld.meldId} aria-label={`${MELD_LABELS[meld.kind]}: ${labels}`}>
      <span className={styles.groupLabel}>{MELD_LABELS[meld.kind]}</span>
      <span className={styles.tileRow} aria-hidden="true">
        {meld.tiles.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)}
      </span>
    </li>
  )
}

export function MeldList({ melds, label }: {
  readonly melds: readonly PlayerVisibleMeld[]
  readonly label: string
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const list = listRef.current
    const frame = frameRef.current
    if (!scroller || !list || !frame) return

    const updateEdges = () => {
      const next = {
        left: scroller.scrollLeft > 1,
        right: scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 1,
      }
      setEdges((current) => current.left === next.left && current.right === next.right ? current : next)
    }
    const measure = () => {
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0
      const singleRowWidth = Array.from(list.children).reduce((width, meld) => width + meld.getBoundingClientRect().width, 0)
        + Math.max(0, list.children.length - 1) * gap
      // Size the frame intrinsically while CSS caps it to the available card width.
      // Measure before the parent computes tile-animation destinations.
      frame.style.width = `${singleRowWidth}px`
      updateEdges()
    }

    measure()
    scroller.addEventListener('scroll', updateEdges, { passive: true })
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(measure)
    })
    observer.observe(scroller)
    observer.observe(list)
    for (const meld of list.children) observer.observe(meld)
    return () => {
      scroller.removeEventListener('scroll', updateEdges)
      observer.disconnect()
      cancelAnimationFrame(resizeFrame)
    }
  }, [melds])

  return (
    <div ref={frameRef} className={styles.frame} data-scroll-left={edges.left} data-scroll-right={edges.right}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="region"
        aria-label={label}
        tabIndex={edges.left || edges.right ? 0 : undefined}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (!(edges.left || edges.right) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
          // WebKit does not consistently scroll a focused overflow region with arrows.
          event.preventDefault()
          event.currentTarget.scrollBy({ left: event.key === 'ArrowRight' ? 40 : -40 })
        }}
      >
        <ul ref={listRef} className={styles.melds}>
          {melds.map((meld) => <Meld meld={meld} key={meld.meldId} />)}
        </ul>
      </div>
    </div>
  )
}
