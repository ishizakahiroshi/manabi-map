/**
 * 都道府県の URL slug（/pref/<slug>/）と地方区分の正典アクセサ。
 * データの実体は web/data/prefectures.json（総務省 全国地方公共団体コード表由来・
 * docs/local/convert-soumu-codes.py で生成）。ビルドスクリプト
 * （scripts/gen-seo-pages.mjs）と同じファイルを参照し、二重管理しない。
 */
import prefData from '../../data/prefectures.json'

export type RegionKey =
  | 'hokkaido-tohoku'
  | 'kanto'
  | 'chubu'
  | 'kinki'
  | 'chugoku-shikoku'
  | 'kyushu-okinawa'

export interface Prefecture {
  /** 都道府県コード（'01'〜'47'） */
  code: string
  name: string
  kana: string
  slug: string
  region: RegionKey
}

/** 全 47 都道府県（コード順）。 */
export const PREFECTURES: readonly Prefecture[] = prefData.prefectures as Prefecture[]

/** 地方区分の表示順（トップの「一覧から探す」・全域ハブと共通）。 */
export const REGION_KEYS: readonly RegionKey[] = [
  'hokkaido-tohoku',
  'kanto',
  'chubu',
  'kinki',
  'chugoku-shikoku',
  'kyushu-okinawa',
]

const bySlug = new Map(PREFECTURES.map((p) => [p.slug, p]))
const byName = new Map(PREFECTURES.map((p) => [p.name, p]))

export function prefectureBySlug(slug: string): Prefecture | null {
  return bySlug.get(slug) ?? null
}

export function prefectureByName(name: string): Prefecture | null {
  return byName.get(name) ?? null
}
