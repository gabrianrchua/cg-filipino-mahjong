import type { SuitedTile, TileId } from '@cg-filipino-mahjong/shared'
import { DragDropProvider, useDragDropManager } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom'
import { useEffect, useRef, useState } from 'react'

import { moveTile, sortedTileIds } from '../realtime/handArrangement.ts'
import { Button } from './Button.tsx'
import { MahjongTile } from './MahjongTile.tsx'
import { tileLabel } from './tileLabels.ts'
import styles from './HandRack.module.css'

interface HandRackProps {
  readonly identity: string
  readonly tiles: readonly SuitedTile[]
  readonly drawnTileId: TileId | null
  readonly legalDiscardTileIds: ReadonlySet<TileId>
  readonly selectedTileId: TileId | null
  readonly discardDisabled: boolean
  readonly discardPending: boolean
  readonly onSelect: (tileId: TileId | null) => void
  readonly onOrderChange: (tileIds: readonly TileId[]) => void
  readonly onDiscard: () => void
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
  })
  const label = tileLabel(tile)

  return (
    <div
      ref={ref}
      className={`${styles.tileSlot} ${drawn ? styles.drawnSlot : ''} ${selected ? styles.selected : ''} ${isDragging ? styles.dragging : ''}`}
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
  identity,
  tiles,
  drawnTileId,
  legalDiscardTileIds,
  selectedTileId,
  discardDisabled,
  discardPending,
  onSelect,
  onOrderChange,
  onDiscard,
}: HandRackProps) {
  const [dragging, setDragging] = useState(false)
  const order = tiles.map((tile) => tile.tileId)
  const signature = `${identity}:${order.slice().sort().join('|')}`
  const dragSignature = useRef<string | null>(null)
  const selectedIndex = selectedTileId ? order.indexOf(selectedTileId) : -1

  const moveSelected = (direction: -1 | 1) => {
    if (!selectedTileId) return
    const next = moveTile(order, selectedTileId, direction)
    if (next !== order) onOrderChange(next)
  }

  return (
    <>
      <div className={styles.controls} aria-label="Hand arrangement controls">
        <Button variant="secondary" disabled={dragging || tiles.length < 2} onClick={() => onOrderChange(sortedTileIds(tiles))}>
          Sort hand
        </Button>
        <Button variant="secondary" disabled={dragging || selectedIndex <= 0} onClick={() => moveSelected(-1)}>
          Move left
        </Button>
        <Button variant="secondary" disabled={dragging || selectedIndex < 0 || selectedIndex >= tiles.length - 1} onClick={() => moveSelected(1)}>
          Move right
        </Button>
        <Button disabled={discardDisabled || discardPending || dragging} onClick={onDiscard}>
          {discardPending ? 'Discarding…' : 'Discard selected tile'}
        </Button>
      </div>
      <p className={styles.help} id="hand-reorder-help">
        Select a legal tile to discard or move with the buttons. Use a reorder handle to drag; keyboard users can press Enter or Space, then an arrow key.
      </p>
      <div className={styles.rack} role="group" aria-label={`Your concealed hand, ${tiles.length} tiles`}>
        <DragDropProvider
          sensors={(defaults) => [
            ...defaults.filter((sensor) => sensor !== PointerSensor),
            PointerSensor.configure({
              activationConstraints: (event) => event.pointerType === 'touch'
                ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 6 })]
                : [new PointerActivationConstraints.Distance({ value: 6 })],
            }),
          ]}
          onDragStart={() => {
            dragSignature.current = signature
            setDragging(true)
          }}
          onDragEnd={(event) => {
            setDragging(false)
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
          <div className={styles.tiles} data-testid="tile-rack">
            {tiles.map((tile, index) => (
              <SortableHandTile
                drawn={drawnTileId === tile.tileId}
                index={index}
                key={tile.tileId}
                onSelect={onSelect}
                selectable={legalDiscardTileIds.has(tile.tileId)}
                selected={selectedTileId === tile.tileId}
                tile={tile}
              />
            ))}
          </div>
        </DragDropProvider>
      </div>
    </>
  )
}
