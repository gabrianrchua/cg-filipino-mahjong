import type { SuitedTile, TileId } from '@cg-filipino-mahjong/shared'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { MahjongTile } from '../components/MahjongTile.tsx'
import styles from './DiscardPile.module.css'

export function DiscardPile({ tiles, pendingTileId }: {
  readonly tiles: readonly SuitedTile[]
  readonly pendingTileId: TileId | null
}) {
  const discards = useMemo(() => tiles.filter((tile) => tile.tileId !== pendingTileId), [tiles, pendingTileId])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const [edges, setEdges] = useState({ left: false, right: false })

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const updateEdges = () => {
      const next = {
        left: scroller.scrollLeft > 1,
        right: scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 1,
      }
      followLatest.current = !next.right
      setEdges((current) => current.left === next.left && current.right === next.right ? current : next)
    }
    const resize = () => {
      if (followLatest.current) scroller.scrollLeft = scroller.scrollWidth
      updateEdges()
    }
    resize()
    scroller.addEventListener('scroll', updateEdges, { passive: true })
    const observer = new ResizeObserver(resize)
    observer.observe(scroller)
    observer.observe(content)
    return () => {
      scroller.removeEventListener('scroll', updateEdges)
      observer.disconnect()
    }
  }, [discards])

  return (
    <section className={styles.pile} aria-label="Shared discard area">
      <span className={styles.heading}>Discards · {discards.length}</span>
      <div className={styles.frame} data-scroll-left={edges.left} data-scroll-right={edges.right}>
        <div
          ref={scrollerRef}
          className={styles.scroller}
          role="region"
          aria-label="Discarded tiles"
          tabIndex={edges.left || edges.right ? 0 : undefined}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            if (!(edges.left || edges.right) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
            event.preventDefault()
            event.currentTarget.scrollBy({ left: event.key === 'ArrowRight' ? 40 : -40 })
          }}
        >
          <div ref={contentRef} className={discards.length ? styles.tiles : styles.empty}>
            {discards.length
              ? discards.map((tile) => <MahjongTile compact tile={tile} key={tile.tileId} />)
              : 'No discards yet'}
          </div>
        </div>
      </div>
    </section>
  )
}
