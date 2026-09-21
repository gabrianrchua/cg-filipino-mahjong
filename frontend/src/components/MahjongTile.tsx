import type { FlowerIdentity, FlowerTile, SuitedTile } from '@cg-filipino-mahjong/shared'

import styles from './MahjongTile.module.css'
import { tileLabel } from './tileLabels.ts'

type VisibleTile = SuitedTile | FlowerTile

interface MahjongTileProps {
  readonly tile: VisibleTile
  readonly compact?: boolean
  readonly drawn?: boolean
  readonly latest?: boolean
}

interface TileBackProps {
  readonly compact?: boolean
  readonly label?: string
}

const FLOWER_MARKS: Readonly<Record<FlowerIdentity, string>> = {
  'east-wind': 'E',
  'south-wind': 'S',
  'west-wind': 'W',
  'north-wind': 'N',
  'red-dragon': 'R',
  'green-dragon': 'G',
  'white-dragon': 'W',
  spring: 'SP',
  summer: 'SU',
  autumn: 'AU',
  winter: 'WI',
  plum: 'PL',
  orchid: 'OR',
  chrysanthemum: 'CH',
  bamboo: 'BA',
}

const TILE_POSITIONS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[16, 22]],
  2: [[9, 11], [23, 33]],
  3: [[9, 11], [16, 22], [23, 33]],
  4: [[9, 11], [23, 11], [9, 33], [23, 33]],
  5: [[9, 11], [23, 11], [16, 22], [9, 33], [23, 33]],
  6: [[9, 11], [23, 11], [9, 22], [23, 22], [9, 33], [23, 33]],
  7: [[9, 8], [16, 12], [23, 16], [9, 26], [23, 26], [9, 35], [23, 35]],
  8: [[9, 7], [23, 7], [9, 17], [23, 17], [9, 27], [23, 27], [9, 37], [23, 37]],
  9: [[9, 9], [16, 9], [23, 9], [9, 22], [16, 22], [23, 22], [9, 35], [16, 35], [23, 35]],
} as const

function SuitedFace({ tile }: { readonly tile: SuitedTile }) {
  if (tile.suit === 'balls') {
    return (
      <svg viewBox="0 0 32 44" aria-hidden="true">
        <rect className={styles.face} x="1" y="1" width="30" height="40" rx="3.5" />
        {TILE_POSITIONS[tile.rank]!.map(([cx, cy], index) => (
          <circle className={index % 3 === 1 ? styles.red : styles.green} cx={cx} cy={cy} r="2.6" key={`${cx}-${cy}`} />
        ))}
        <path className={styles.edge} d="M4 41h24" />
      </svg>
    )
  }

  if (tile.suit === 'sticks') {
    return (
      <svg viewBox="0 0 32 44" aria-hidden="true">
        <rect className={styles.face} x="1" y="1" width="30" height="40" rx="3.5" />
        {TILE_POSITIONS[tile.rank]!.map(([x, y], index) => (
          <g className={index % 3 === 1 ? styles.redStroke : styles.greenStroke} key={`${x}-${y}`}>
            <path d={`M${x} ${y - 3.5}v7`} />
          </g>
        ))}
        <path className={styles.edge} d="M4 41h24" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 32 44" aria-hidden="true">
      <rect className={styles.face} x="1" y="1" width="30" height="40" rx="3.5" />
      <text className={styles.characterRank} x="16" y="21" textAnchor="middle">{tile.rank}</text>
      <text className={styles.characterSuit} x="16" y="31" textAnchor="middle">CHAR</text>
      <path className={styles.edge} d="M4 41h24" />
    </svg>
  )
}

function FlowerFace({ tile }: { readonly tile: FlowerTile }) {
  const isDragon = tile.identity.endsWith('dragon')
  const isWind = tile.identity.endsWith('wind')
  return (
    <svg viewBox="0 0 32 44" aria-hidden="true">
      <rect className={styles.face} x="1" y="1" width="30" height="40" rx="3.5" />
      {isWind || isDragon ? (
        <>
          <circle className={isDragon ? styles.flowerRingDragon : styles.flowerRing} cx="16" cy="18" r="9" />
          <text className={isDragon ? styles.dragonMark : styles.windMark} x="16" y="22" textAnchor="middle">
            {FLOWER_MARKS[tile.identity]}
          </text>
        </>
      ) : (
        <>
          <path className={styles.stem} d="M16 32c0-8 1-13 6-18M16 25c-5-1-7-4-8-7M18 23c5 0 7-3 8-6" />
          <circle className={styles.petal} cx="22" cy="13" r="4" />
          <text className={styles.flowerMark} x="9" y="36">{FLOWER_MARKS[tile.identity]}</text>
        </>
      )}
      <path className={styles.edge} d="M4 41h24" />
    </svg>
  )
}

export function MahjongTile({ compact = false, drawn = false, latest = false, tile }: MahjongTileProps) {
  const className = [styles.tile, compact ? styles.compact : '', drawn ? styles.drawn : '', latest ? styles.latest : '']
    .filter(Boolean)
    .join(' ')
  return (
    <span className={className} role="img" aria-label={`${tileLabel(tile)}${drawn ? ', drawn tile' : ''}${latest ? ', latest discard' : ''}`} data-tile-id={tile.tileId}>
      {tile.kind === 'suited' ? <SuitedFace tile={tile} /> : <FlowerFace tile={tile} />}
    </span>
  )
}

export function TileBack({ compact = false, label }: TileBackProps) {
  return (
    <span className={`${styles.tile} ${styles.back} ${compact ? styles.compact : ''}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <svg viewBox="0 0 32 44" aria-hidden="true">
        <rect className={styles.backFace} x="1" y="1" width="30" height="40" rx="3.5" />
        <path className={styles.backPattern} d="M8 10h16v20H8zM11 13l10 14M21 13L11 27" />
        <path className={styles.edge} d="M4 41h24" />
      </svg>
    </span>
  )
}
