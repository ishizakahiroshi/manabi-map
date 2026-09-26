// N1 保存の境界（子 plan C10 N1・native readiness 文書 §2）。indexedDB / localStorage /
// sessionStorage を lib/store.ts の外（画面・部品・ほかのロジック）から直接使っていないことを、
// ソースの中身を文字列として読んで固定する。
//
// 読み方は import.meta.glob（他の C からずっと使っている Vite の仕組み。i18n/packs.ts の
// uiRawLoaders と同じ query: 'raw'）でファイルの中身を文字列として集める。node:fs や
// /// <reference types="node" /> は使わない（2026-09-24 C9 レビュー must 1: triple-slash の
// 参照は tsconfig.app.json の対象全体（学校サイトを含む）に Node の型を足してしまい、
// "types": ["vite/client"] の絞り込みが崩れるため）。
//
// このテストファイル自身（*.test.ts / *.test.tsx）は対象から外す。

import { describe, expect, it } from 'vitest'

const FORBIDDEN_RE = /indexedDB|localStorage|sessionStorage/
const STORE_PATH = './lib/store.ts'

/** web/src/kanji 配下の .ts / .tsx を、中身を文字列（raw）にして eager に集める */
const sourceFiles = import.meta.glob<string>('./**/*.{ts,tsx}', { eager: true, import: 'default', query: 'raw' })

function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('.test.tsx')
}

describe('N1 保存の境界（indexedDB / localStorage / sessionStorage は lib/store.ts だけ）', () => {
  it('lib/store.ts 以外のソースに indexedDB / localStorage / sessionStorage が無い', () => {
    const offenders = Object.entries(sourceFiles)
      .filter(([path]) => !isTestFile(path) && path !== STORE_PATH)
      .filter(([, content]) => FORBIDDEN_RE.test(content))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })

  it('lib/store.ts では実際に indexedDB を使っている（誤って対象から外れていないことの確認）', () => {
    const storeContent = sourceFiles[STORE_PATH]
    expect(storeContent).toBeDefined()
    expect(FORBIDDEN_RE.test(storeContent ?? '')).toBe(true)
  })

  it('glob が web/src/kanji のファイルを一定数拾えている（0 件で静かに通らないことの確認）', () => {
    const nonTestCount = Object.keys(sourceFiles).filter((path) => !isTestFile(path)).length
    expect(nonTestCount).toBeGreaterThan(10)
  })

  // should 1（2026-09-24 C10 レビュー）: 上の件数の下限だけだと、.ts だけで既に 10 件を超えるため、
  // glob のパターンが誤って './**/*.ts'（.tsx を拾わない）に戻っても気づけない。.tsx を実際に
  // 拾えていることを、件数と具体的な 1 ファイル（N1「作業内容」で例に挙げた画面ファイル）の
  // 両方で確かめる。
  it('.tsx も拾えている（.ts だけに絞られていないことの確認）', () => {
    const tsxCount = Object.keys(sourceFiles).filter((path) => path.endsWith('.tsx') && !isTestFile(path)).length
    expect(tsxCount).toBeGreaterThan(0)
    expect(sourceFiles['./pages/AboutPage.tsx']).toBeDefined()
  })
})
