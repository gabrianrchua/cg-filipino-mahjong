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

const BALL_POSITIONS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[16, 22]],
  2: [[9, 14], [23, 34]],
  3: [[9, 14], [16, 24], [23, 34]],
  4: [[9, 14], [23, 14], [9, 34], [23, 34]],
  5: [[9, 14], [23, 14], [16, 24], [9, 34], [23, 34]],
  6: [[9, 14], [23, 14], [9, 24], [23, 24], [9, 34], [23, 34]],
  7: [[9, 12], [16, 16], [23, 20], [9, 28], [23, 28], [9, 35], [23, 35]],
  8: [[9, 12], [23, 12], [9, 20], [23, 20], [9, 28], [23, 28], [9, 35], [23, 35]],
  9: [[9, 14], [16, 14], [23, 14], [9, 24], [16, 24], [23, 24], [9, 35], [16, 35], [23, 35]],
} as const

const STICK_POSITIONS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  1: [[16, 22]],
  2: [[9, 14], [23, 34]],
  3: [[9, 14], [16, 24], [23, 34]],
  4: [[9, 14], [23, 14], [9, 34], [23, 34]],
  5: [[9, 14], [23, 14], [16, 24], [9, 34], [23, 34]],
  6: [[9, 14], [23, 14], [9, 24], [23, 24], [9, 34], [23, 34]],
  7: [[16, 14], [9, 24], [16, 24], [23, 24], [9, 34], [16, 34], [23, 34]],
  8: [[9, 17.5], [12.5, 17.5], [19.5, 17.5], [23, 17.5], [9, 27.5], [12.5, 27.5], [19.5, 27.5], [23, 27.5]],
  9: [[9, 14], [16, 14], [23, 14], [9, 24], [16, 24], [23, 24], [9, 34], [16, 34], [23, 34]],
} as const

function SuitedFace({ tile }: { readonly tile: SuitedTile }) {
  if (tile.suit === 'balls') {
    return (
      <svg viewBox="0 0 32 44" aria-hidden="true">
        <rect className={styles.face} x="1" y="1" width="30" height="40" rx="3.5" />
        <text className={styles.suitedRank} x="5" y="9" textAnchor="middle">{tile.rank}</text>
        {BALL_POSITIONS[tile.rank]!.map(([cx, cy], index) => (
          <circle className={index % 3 === 1 ? styles.red : styles.green} cx={cx} cy={cy} r={tile.rank === 1 ? 6 : 2.6} key={`${cx}-${cy}`} />
        ))}
        <path className={styles.edge} d="M4 41h24" />
      </svg>
    )
  }

  if (tile.suit === 'sticks') {
    return (
      <svg viewBox="0 0 32 44" aria-hidden="true">
        <rect className={styles.face} x="1" y="1" width="30" height="40" rx="3.5" />
        <text className={styles.suitedRank} x="5" y="9" textAnchor="middle">{tile.rank}</text>
        {STICK_POSITIONS[tile.rank]!.map(([x, y], index) => (
          <g className={index % 3 === 1 ? styles.redStroke : styles.greenStroke} key={`${x}-${y}`}>
            <path
              d={tile.rank === 1 ? `M${x} ${y - 8}v16` : `M${x} ${y - 3.5}v7`}
              transform={tile.rank === 8 && (index === 1 || index === 2 || index === 5 || index === 6)
                ? `rotate(${index === 1 || index === 6 ? 45 : -45} ${x} ${y})`
                : undefined}
            />
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
