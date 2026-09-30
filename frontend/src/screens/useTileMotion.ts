import type { ActiveGameSnapshot } from '@cg-filipino-mahjong/shared'
import { useLayoutEffect, useRef, type RefObject } from 'react'

import { tileMotions, type TileMotion } from './tileMotion.ts'

type PositionMap = Map<string, DOMRect>

function locations(table: HTMLElement, hand: HTMLElement | null): PositionMap {
  const result: PositionMap = new Map()
  const record = (key: string, element: Element | null) => {
    if (element) result.set(key, element.getBoundingClientRect())
  }
  record('center', table.querySelector('[data-motion-discard] [data-tile-id]'))
  record('wall', table.querySelector('[data-motion-wall] .tile-back'))
  for (const seat of table.querySelectorAll<HTMLElement>('[data-seat]')) {
    record(`seat:${seat.dataset.seat}`, seat.querySelector('[data-motion-seat-anchor]'))
  }
  for (const tile of hand?.querySelectorAll<HTMLElement>('[data-hand-tile-id]') ?? []) {
    record(`hand:${tile.dataset.handTileId}`, tile.querySelector('[data-tile-id]'))
  }
  const localAnchor = hand?.querySelector<HTMLElement>('[data-motion-seat-anchor][data-seat]')
  if (localAnchor) record(`seat:${localAnchor.dataset.seat}`, localAnchor)
  for (const meld of table.querySelectorAll<HTMLElement>('[data-motion-meld-id]')) {
    for (const tile of meld.querySelectorAll<HTMLElement>('[data-tile-id]')) {
      record(`meld:${meld.dataset.motionMeldId}:${tile.dataset.tileId}`, tile)
    }
  }
  return result
}

function onScreen(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0
    && rect.right > 0 && rect.bottom > 0
    && rect.left < window.innerWidth && rect.top < window.innerHeight
}

function visibleWithinScrollParents(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  if (!onScreen(rect)) return false
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    const bounds = parent.getBoundingClientRect()
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) return false
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.right <= bounds.left || rect.left >= bounds.right)) return false
  }
  return true
}

function atViewportEdge(rect: DOMRect): DOMRect {
  return new DOMRect(
    Math.min(Math.max(rect.left, 0), Math.max(0, window.innerWidth - rect.width)),
    Math.min(Math.max(rect.top, 0), Math.max(0, window.innerHeight - rect.height)),
    rect.width,
    rect.height,
  )
}

function sourceFor(motion: TileMotion, previous: PositionMap, current: PositionMap, localSeat: number): DOMRect | undefined {
  if (motion.kind === 'draw') return current.get('wall')
  if (motion.kind === 'discard') {
    return motion.seat === localSeat
      ? previous.get(`hand:${motion.tileId}`)
      : current.get(`seat:${motion.seat}`)
  }
  if (motion.claimed) return previous.get('center')
  return motion.seat === localSeat
    ? previous.get(`hand:${motion.tileId}`)
    : current.get(`seat:${motion.seat}`)
}

function destinationFor(motion: TileMotion, current: PositionMap): DOMRect | undefined {
  if (motion.kind === 'draw') return current.get(`hand:${motion.tileId}`)
  if (motion.kind === 'discard') return current.get('center')
  return current.get(`meld:${motion.meldId}:${motion.tileId}`)
}

function destinationElement(motion: TileMotion, table: HTMLElement, hand: HTMLElement | null): HTMLElement | null {
  if (motion.kind === 'draw' && !hand) return null
  const container = motion.kind === 'draw' ? hand! : table
  const selector = motion.kind === 'draw'
    ? '[data-hand-tile-id] [data-tile-id]'
    : motion.kind === 'discard'
      ? '[data-motion-discard] [data-tile-id]'
      : '[data-motion-meld-id] [data-tile-id]'
  for (const tile of container.querySelectorAll<HTMLElement>(selector)) {
    if (tile.dataset.tileId !== motion.tileId) continue
    if (motion.kind === 'meld' && tile.closest<HTMLElement>('[data-motion-meld-id]')?.dataset.motionMeldId !== motion.meldId) continue
    return tile
  }
  return null
}

function flyTile(tile: HTMLElement, source: DOMRect, destination: DOMRect, kind: TileMotion['kind']): () => void {
  const origin = atViewportEdge(source.width > destination.width * 2
    ? new DOMRect(
      source.left + (source.width - destination.width) / 2,
      source.top + (source.height - destination.height) / 2,
      destination.width,
      destination.height,
    )
    : source)
  const target = atViewportEdge(destination)
  const ghost = tile.cloneNode(true) as HTMLElement
  ghost.removeAttribute('role')
  ghost.removeAttribute('aria-label')
  ghost.removeAttribute('data-tile-id')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.dataset.motionFlight = kind
  ghost.style.position = 'fixed'
  ghost.style.left = `${target.left}px`
  ghost.style.top = `${target.top}px`
  ghost.style.width = `${destination.width}px`
  ghost.style.height = `${destination.height}px`
  ghost.style.margin = '0'
  ghost.style.transform = 'none'
  ghost.style.transformOrigin = 'top left'
  ghost.style.pointerEvents = 'none'
  ghost.style.zIndex = '20'
  document.body.append(ghost)
  const previousVisibility = tile.style.visibility
  if (onScreen(destination)) tile.style.visibility = 'hidden'

  let finished = false
  const animation = ghost.animate([
    {
      transform: `translate(${origin.left - target.left}px, ${origin.top - target.top}px) scale(${origin.width / destination.width}, ${origin.height / destination.height})`,
      opacity: 0.82,
    },
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
  ], { duration: 220, easing: 'cubic-bezier(0.2, 0.75, 0.3, 1)', fill: 'forwards' })
  const cleanup = () => {
    if (finished) return
    finished = true
    animation.cancel()
    tile.style.visibility = previousVisibility
    ghost.remove()
  }
  animation.onfinish = cleanup
  return cleanup
}

export function useTileMotion(
  snapshot: ActiveGameSnapshot | null,
  suppressMotion: boolean,
  tableRef: RefObject<HTMLDivElement | null>,
  handRef: RefObject<HTMLElement | null>,
): void {
  const previous = useRef<{ snapshot: ActiveGameSnapshot; positions: PositionMap } | null>(null)
  const active = useRef<readonly (() => void)[]>([])

  useLayoutEffect(() => {
    const table = tableRef.current
    const hand = handRef.current
    if (!snapshot || !table || suppressMotion) {
      active.current.forEach((cleanup) => cleanup())
      active.current = []
      previous.current = null
      return
    }
    const positions = locations(table, hand)
    const before = previous.current
    const changed = before && (before.snapshot.roomRevision !== snapshot.roomRevision
      || before.snapshot.gameRevision !== snapshot.gameRevision
      || before.snapshot.handId !== snapshot.handId)
    if (changed) {
      active.current.forEach((cleanup) => cleanup())
      active.current = []
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        active.current = tileMotions(before.snapshot, snapshot).flatMap((motion) => {
          const source = sourceFor(motion, before.positions, positions, snapshot.self.seat ?? -1)
          const destination = destinationFor(motion, positions)
          const tile = destinationElement(motion, table, hand)
          if (!source || !destination || !tile || !visibleWithinScrollParents(tile) || (!onScreen(source) && !onScreen(destination))) return []
          return [flyTile(tile, source, destination, motion.kind)]
        })
      }
    }
    previous.current = { snapshot, positions }
  })

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    const refreshPositions = () => {
      const table = tableRef.current
      const hand = handRef.current
      if (previous.current && table) previous.current.positions = locations(table, hand)
    }
    window.addEventListener('scroll', refreshPositions, true)
    window.addEventListener('resize', refreshPositions)
    return () => {
      window.removeEventListener('scroll', refreshPositions, true)
      window.removeEventListener('resize', refreshPositions)
      active.current.forEach((cleanup) => cleanup())
    }
  }, [tableRef, handRef])
}
