import type { SuitedTile, WinningDecomposition } from '@cg-filipino-mahjong/shared'

import type { DeclaredMeld } from './model.js'

type DecompositionGroup = WinningDecomposition['groups'][number]

const suitOrder = { sticks: 0, balls: 1, characters: 2 } as const

function compareTiles(left: SuitedTile, right: SuitedTile): number {
  return suitOrder[left.suit] - suitOrder[right.suit]
    || left.rank - right.rank
    || left.tileId.localeCompare(right.tileId)
}

function sameFace(left: SuitedTile, right: SuitedTile): boolean {
  return left.suit === right.suit && left.rank === right.rank
}

function removeTiles(tiles: readonly SuitedTile[], selected: readonly SuitedTile[]): SuitedTile[] {
  const selectedIds = new Set(selected.map((tile) => tile.tileId))
  return tiles.filter((tile) => !selectedIds.has(tile.tileId))
}

function declaredGroup(meld: DeclaredMeld): DecompositionGroup {
  return {
    kind: meld.kind === 'chow' ? 'chow' : meld.kind === 'pong' ? 'pong' : 'kang',
    tiles: [...meld.tiles],
  }
}

function findMelds(
  input: readonly SuitedTile[],
  requiredMelds: number,
): readonly DecompositionGroup[] | null {
  if (requiredMelds === 0) return input.length === 0 ? [] : null
  if (input.length !== requiredMelds * 3) return null

  const tiles = [...input].sort(compareTiles)
  const first = tiles[0]!
  const matching = tiles.filter((tile) => sameFace(tile, first))

  if (matching.length >= 3) {
    const pongTiles = matching.slice(0, 3)
    const remainder = findMelds(removeTiles(tiles, pongTiles), requiredMelds - 1)
    if (remainder !== null) {
      return [{ kind: 'pong', tiles: pongTiles }, ...remainder]
    }
  }

  if (first.rank <= 7) {
    const second = tiles.find((tile) => tile.suit === first.suit && tile.rank === first.rank + 1)
    const third = tiles.find((tile) => tile.suit === first.suit && tile.rank === first.rank + 2)
    if (second && third) {
      const chowTiles = [first, second, third]
      const remainder = findMelds(removeTiles(tiles, chowTiles), requiredMelds - 1)
      if (remainder !== null) {
        return [{ kind: 'chow', tiles: chowTiles }, ...remainder]
      }
    }
  }

  return null
}

function findRegularDecomposition(
  concealedTiles: readonly SuitedTile[],
  declaredMelds: readonly DeclaredMeld[],
): WinningDecomposition | null {
  const requiredMelds = 5 - declaredMelds.length
  if (requiredMelds < 0 || concealedTiles.length !== (requiredMelds * 3) + 2) return null

  const tiles = [...concealedTiles].sort(compareTiles)
  for (let index = 0; index < tiles.length - 1; index += 1) {
    const first = tiles[index]!
    const second = tiles.slice(index + 1).find((tile) => sameFace(tile, first))
    if (!second) continue

    const melds = findMelds(removeTiles(tiles, [first, second]), requiredMelds)
    if (melds !== null) {
      return {
        kind: 'regular',
        groups: [
          { kind: 'pair', tiles: [first, second] },
          ...declaredMelds.map(declaredGroup),
          ...melds,
        ],
      }
    }

    // Trying another physical copy of the same face cannot change the face-level decomposition.
    while (index + 1 < tiles.length && sameFace(tiles[index + 1]!, first)) index += 1
  }

  return null
}

function findAlternateDecomposition(
  concealedTiles: readonly SuitedTile[],
  declaredMelds: readonly DeclaredMeld[],
): WinningDecomposition | null {
  if (declaredMelds.length !== 0 || concealedTiles.length !== 17) return null

  const tiles = [...concealedTiles].sort(compareTiles)
  const faces: SuitedTile[][] = []
  for (const tile of tiles) {
    const group = faces.at(-1)
    if (group && sameFace(group[0]!, tile)) group.push(tile)
    else faces.push([tile])
  }

  for (const pongFace of faces.filter((face) => face.length >= 3)) {
    const pongTiles = pongFace.slice(0, 3)
    const remaining = removeTiles(tiles, pongTiles)
    const remainingFaces: SuitedTile[][] = []
    for (const tile of remaining) {
      const group = remainingFaces.at(-1)
      if (group && sameFace(group[0]!, tile)) group.push(tile)
      else remainingFaces.push([tile])
    }
    if (remainingFaces.some((face) => face.length % 2 !== 0)) continue

    const pairs: DecompositionGroup[] = []
    for (const face of remainingFaces) {
      for (let index = 0; index < face.length; index += 2) {
        pairs.push({ kind: 'pair', tiles: [face[index]!, face[index + 1]!] })
      }
    }
    if (pairs.length === 7) {
      return {
        kind: 'seven-pairs-plus-pong',
        groups: [...pairs, { kind: 'pong', tiles: pongTiles }],
      }
    }
  }

  return null
}

/**
 * Finds one deterministic, physical-tile decomposition for a complete hand.
 * The alternate hand is preferred when a fully concealed hand satisfies both forms.
 */
export function findWinningDecomposition(
  concealedTiles: readonly SuitedTile[],
  declaredMelds: readonly DeclaredMeld[],
): WinningDecomposition | null {
  return findAlternateDecomposition(concealedTiles, declaredMelds)
    ?? findRegularDecomposition(concealedTiles, declaredMelds)
}
