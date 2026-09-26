import type { Level } from '../types'

/** 学齢帯。es=小学生 / jh=中学生 / hs=高校・一般 / ad=大学・一般（親 plan D-6・D-7） */
export type LevelBand = 'es' | 'jh' | 'hs' | 'ad'

export interface LevelEntry {
  key: Level
  /** その級までの累計字数 */
  total: number
  /** 字数が概数か（推定値のときだけ true） */
  approx: boolean
  band: LevelBand
  /** 問題を出せるか（準1級・1級は準備中のため false。親 plan D-6） */
  available: boolean
}

/**
 * 級の表。易しい順（levelRank の順）に並べる。
 * 字数は漢検の公式の級別ページの値を共有用モック v4 から書き写したもので未確認。
 * 親 plan C3 で公式ページと突き合わせて確定する（子 plan「調査で確認した現在の実装」）。
 */
export const LEVELS: LevelEntry[] = [
  { key: '10', total: 80, approx: false, band: 'es', available: true },
  { key: '9', total: 240, approx: false, band: 'es', available: true },
  { key: '8', total: 440, approx: false, band: 'es', available: true },
  { key: '7', total: 642, approx: false, band: 'es', available: true },
  { key: '6', total: 835, approx: false, band: 'es', available: true },
  { key: '5', total: 1026, approx: false, band: 'es', available: true },
  { key: '4', total: 1339, approx: false, band: 'jh', available: true },
  { key: '3', total: 1623, approx: false, band: 'jh', available: true },
  { key: 'pre2', total: 1951, approx: false, band: 'hs', available: true },
  { key: '2', total: 2136, approx: false, band: 'hs', available: true },
  { key: 'pre1', total: 3000, approx: true, band: 'ad', available: false },
  { key: '1', total: 6000, approx: true, band: 'ad', available: false },
]

const LEVEL_RANK: Record<Level, number> = Object.fromEntries(
  LEVELS.map((entry, index) => [entry.key, index]),
) as Record<Level, number>

const LEVEL_KEYS = new Set<string>(LEVELS.map((entry) => entry.key))

/** 易しい順の順位（10 → 0 … 2 → 9、pre1 → 10、1 → 11） */
export function levelRank(level: Level): number {
  return LEVEL_RANK[level]
}

/** 値が Level かどうかの型ガード */
export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && LEVEL_KEYS.has(value)
}

/** 画面表示用の分解（言語パックの文言と組み合わせて使う。級の名前の文字列はここで作らない） */
export function levelParts(level: Level): { n: string; pre: boolean } {
  if (level.startsWith('pre')) {
    return { n: level.slice(3), pre: true }
  }
  return { n: level, pre: false }
}
