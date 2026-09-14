import type { FlowerIdentity, FlowerTile, SuitedTile } from '@cg-filipino-mahjong/shared'

const NUMBER_WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'] as const

const FLOWER_LABELS: Readonly<Record<FlowerIdentity, string>> = {
  'east-wind': 'East wind',
  'south-wind': 'South wind',
  'west-wind': 'West wind',
  'north-wind': 'North wind',
  'red-dragon': 'Red dragon',
  'green-dragon': 'Green dragon',
  'white-dragon': 'White dragon',
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
  plum: 'Plum flower',
  orchid: 'Orchid flower',
  chrysanthemum: 'Chrysanthemum flower',
  bamboo: 'Bamboo flower',
}

export function tileLabel(tile: SuitedTile | FlowerTile): string {
  if (tile.kind === 'flower') return FLOWER_LABELS[tile.identity]
  return `${NUMBER_WORDS[tile.rank - 1]} of ${tile.suit}`
}
