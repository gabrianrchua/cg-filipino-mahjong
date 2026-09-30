import type { SuitedTile, TileId } from '@cg-filipino-mahjong/shared'
import { DragDropProvider, useDragDropManager } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { KeyboardSensor, PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import { moveTile } from '../realtime/handArrangement.ts'
import { Button } from './Button.tsx'
import { MahjongTile } from './MahjongTile.tsx'
import { tileLabel } from './tileLabels.ts'
import styles from './HandRack.module.css'

interface HandRackProps {
  readonly attention: boolean
  readonly identity: string
  readonly tiles: readonly SuitedTile[]
  readonly drawnTileId: TileId | null
  readonly legalDiscardTileIds: ReadonlySet<TileId>
  readonly selectedTileId: TileId | null
  readonly autoSortHand: boolean
  readonly arranging: boolean
  readonly onArrangeDone: () => void
  readonly onDraggingChange: (dragging: boolean) => void
  readonly onSelect: (tileId: TileId | null) => void
  readonly onOrderChange: (tileIds: readonly TileId[]) => void
  readonly onSortToggle: () => void
}

// External cancellation must also release the keyboard sensor's document listener;
// otherwise the next Enter press is consumed by the previous drag.
class HandKeyboardSensor extends KeyboardSensor {
  protected override handleStart(event: KeyboardEvent, ...args: Parameters<KeyboardSensor['bind']>) {
    super.handleStart(event, args[0], args[1])
    const controller = this.manager.dragOperation.controller
    if (controller?.signal.aborted) this.cleanup()
    else controller?.signal.addEventListener('abort', () => this.cleanup(), { once: true })
  }
}

function DragCancellationGuard({ signature }: { readonly signature: string }) {
  const manager = useDragDropManager()
  const previousSignature = useRef(signature)

  useEffect(() => {
    if (previousSignature.current !== signature && manager?.dragOperation.source) {
      manager.actions.stop({ canceled: true })
    }
    previousSignature.current = signature
  }, [manager, signature])

  useEffect(() => {
    // The drag library commits keyboard drags on resize by default. Cancel first,
    // before the new row geometry can turn an unfinished move into a saved order.
    const cancel = () => {
      if (manager?.dragOperation.source) manager.actions.stop({ canceled: true })
    }
    if (typeof window === 'undefined') return
    window.addEventListener('resize', cancel, true)
    return () => window.removeEventListener('resize', cancel, true)
  }, [manager])

  return null
}

function SortableHandTile({
  drawn,
  index,
  selected,
  selectable,
  tile,
  onSelect,
}: {
  readonly drawn: boolean
  readonly index: number
  readonly selected: boolean
  readonly selectable: boolean
  readonly tile: SuitedTile
  readonly onSelect: (tileId: TileId | null) => void
}) {
  const { handleRef, isDragging, ref } = useSortable({
    id: tile.tileId,
    index,
    group: 'local-hand',
    transition: { duration: 180, easing: 'ease-out', idle: true },
  })
  const label = tileLabel(tile)

  return (
    <div
      ref={ref}
      className={`${styles.tileSlot} ${selected ? styles.selected : ''} ${isDragging ? styles.dragging : ''}`}
      data-hand-tile-id={tile.tileId}
    >
      <button
        className={styles.tileButton}
        type="button"
        aria-label={`${selected ? 'Deselect' : 'Select'} ${label}${drawn ? ', drawn tile' : ''}`}
        aria-pressed={selected}
        disabled={!selectable}
        onClick={() => onSelect(selected ? null : tile.tileId)}
      >
        <MahjongTile tile={tile} drawn={drawn} />
      </button>
      <button
        ref={handleRef}
        className={styles.dragHandle}
        type="button"
        aria-label={`Reorder ${label}`}
        aria-describedby="hand-reorder-help"
      >
        <span aria-hidden="true">⠿</span>
      </button>
    </div>
  )
}

export function HandRack({
  attention,
  identity,
  tiles,
  drawnTileId,
  legalDiscardTileIds,
  selectedTileId,
  autoSortHand,
  arranging,
  onArrangeDone,
  onDraggingChange,
  onSelect,
  onOrderChange,
  onSortToggle,
}: HandRackProps) {
  const [dragging, setDragging] = useState(false)
  const [arrangementSelection, setArrangementSelection] = useState<{ identity: string; tileId: TileId } | null>(null)
  const [layout, setLayout] = useState('')
  const [fittingColumns, setFittingColumns] = useState(1)
  const rackRef = useRef<HTMLDivElement>(null)
  const tilesRef = useRef<HTMLDivElement>(null)
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false })
  // Balance overflowing hands; once they fit, fill the available width first.
  const columns = Math.max(1, Math.min(tiles.length, Math.max(Math.ceil(tiles.length / 2), fittingColumns)))
  const order = tiles.map((tile) => tile.tileId)
  const signature = `${layout}:${identity}:${order.slice().sort().join('|')}`
  const dragSignature = useRef<string | null>(null)
  const activeTileId = arranging ? (arrangementSelection?.identity === identity ? arrangementSelection.tileId : null) : selectedTileId
  const selectedIndex = activeTileId ? order.indexOf(activeTileId) : -1

  useLayoutEffect(() => {
    const rack = rackRef.current
    const tileRow = tilesRef.current
    if (!rack || !tileRow) return

    const updateEdges = () => {
      const rackStyle = getComputedStyle(rack)
      const rowStyle = getComputedStyle(tileRow)
      const tile = tileRow.querySelector<HTMLElement>('[data-hand-tile-id]')
      if (tile) {
        const tileWidth = Number.parseFloat(getComputedStyle(tile).width)
        const gap = Number.parseFloat(rowStyle.columnGap) || 0
        const available = rack.clientWidth - Number.parseFloat(rackStyle.paddingLeft) - Number.parseFloat(rackStyle.paddingRight)
        if (tileWidth > 0) setFittingColumns(Math.max(1, Math.floor((available + gap) / (tileWidth + gap))))
      }
      setLayout(`${rack.clientWidth}:${getComputedStyle(tileRow).gridTemplateColumns}`)
      const maxScroll = rack.scrollWidth - rack.clientWidth
      const next = {
        left: rack.scrollLeft > 1,
        right: rack.scrollLeft < maxScroll - 1,
      }
      setScrollEdges((current) => current.left === next.left && current.right === next.right ? current : next)
    }

    updateEdges()
    rack.addEventListener('scroll', updateEdges, { passive: true })
    const observer = new ResizeObserver(updateEdges)
    observer.observe(rack)
    observer.observe(tileRow)
    return () => {
      rack.removeEventListener('scroll', updateEdges)
      observer.disconnect()
    }
  }, [tiles.length])

  const moveSelected = (direction: -1 | 1) => {
    if (!activeTileId) return
    const next = moveTile(order, activeTileId, direction)
    if (next !== order) onOrderChange(next)
  }

  return (
    <>
      <div className={`${styles.controls} ${arranging ? styles.arranging : ''}`} aria-label="Hand arrangement controls">
        <Button className={styles.sortToggle} variant="secondary" aria-label="Sort hand" aria-pressed={autoSortHand} disabled={dragging} onClick={onSortToggle}>
          Sort
        </Button>
        <Button variant="secondary" aria-label="Move left" title="Move selected tile left" disabled={dragging || selectedIndex <= 0} onClick={() => moveSelected(-1)}>
          <span aria-hidden="true">←</span>
        </Button>
        <Button variant="secondary" aria-label="Move right" title="Move selected tile right" disabled={dragging || selectedIndex < 0 || selectedIndex >= tiles.length - 1} onClick={() => moveSelected(1)}>
          <span aria-hidden="true">→</span>
        </Button>
        {arranging ? <Button onClick={onArrangeDone} disabled={dragging}>Done arranging</Button> : null}
      </div>
      <p className={styles.srOnly} id="hand-reorder-help">
        Select a legal tile to discard. In Arrange hand mode, select any tile and use the movement buttons. Use a reorder handle to drag; keyboard users can press Enter or Space, then an arrow key.
      </p>
      <div className={styles.rackFrame} data-scroll-left={scrollEdges.left} data-scroll-right={scrollEdges.right}>
        <div ref={rackRef} className={`${styles.rack} ${attention ? styles.attention : ''}`} role="group" aria-label={`Your concealed hand, ${tiles.length} tiles`}>
          <DragDropProvider
            sensors={(defaults) => [
              ...defaults.filter((sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor),
              HandKeyboardSensor,
              PointerSensor.configure({
                activationConstraints: (event) => event.pointerType === 'touch'
                  ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 6 })]
                  : [new PointerActivationConstraints.Distance({ value: 6 })],
              }),
            ]}
            onDragStart={() => {
              dragSignature.current = signature
              setDragging(true)
              onDraggingChange(true)
            }}
            onDragEnd={(event) => {
              setDragging(false)
              onDraggingChange(false)
              if (event.canceled || dragSignature.current !== signature) return
              const source = event.operation.source
              if (!isSortable(source)) return
              const current = order
              if (current[source.initialIndex] !== source.id || source.index < 0 || source.index >= current.length) return
              const next = [...current]
              const [moved] = next.splice(source.initialIndex, 1)
              if (!moved) return
              next.splice(source.index, 0, moved)
              if (source.initialIndex !== source.index) onOrderChange(next)
            }}
          >
            <DragCancellationGuard signature={signature} />
            <div ref={tilesRef} className={styles.tiles} style={{ '--hand-columns': columns } as CSSProperties} data-testid="tile-rack">
              {tiles.map((tile, index) => (
                <SortableHandTile
                  drawn={drawnTileId === tile.tileId}
                  index={index}
                  key={tile.tileId}
                  onSelect={(tileId) => {
                    if (arranging) setArrangementSelection(tileId ? { identity, tileId } : null)
                    else onSelect(tileId)
                  }}
                  selectable={arranging || legalDiscardTileIds.has(tile.tileId)}
                  selected={activeTileId === tile.tileId}
                  tile={tile}
                />
              ))}
            </div>
          </DragDropProvider>
        </div>
      </div>
    </>
  )
}
