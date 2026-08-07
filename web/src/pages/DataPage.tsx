import { useEffect, useRef, useState } from 'react'
import datasetClaims from '../../data/dataset-claims.json'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import { getInitialData } from '../lib/initialData'
import { PREFECTURES } from '../lib/prefecture'

type DatasetMetadata = {
  school_count: number
  prefecture_count: number
  /** slug → 収録校数。県別エンドポイント一覧の正典。 */
  prefectures?: Record<string, number>
}

export function DataPage() {
  const goBack = useGoBack('/')
  const { t } = useI18n()
  // プリレンダーが埋め込んだ件数があれば初回 render から使う（plan_ssr-hydration.md）。
  // 無いと収録範囲が「収録対象」のままの HTML になり、hydration 後に件数へ差し替わる。
  const [metadata, setMetadata] = useState<DatasetMetadata | null>(
    () => getInitialData()?.datasetMetadata ?? null,
  )
  const settled = useRef(metadata != null)

  useEffect(() => {
    if (settled.current) return
    let active = true
    fetch('/api/v1/dataset.json')
      .then((response) => {
        if (!response.ok) throw new Error(`dataset metadata: HTTP ${response.status}`)
        return response.json() as Promise<DatasetMetadata>
      })
      .then((value) => {
        if (active) {
          settled.current = true
          setMetadata(value)
        }
      })
      .catch(() => {
        // 件数が読めなくても、API URL・方針・訂正窓口は表示し続ける。
      })
    return () => {
      active = false
    }
  }, [])

  // 県別エンドポイントは 1 件の例示だと残り 46 件の綴りを読者に推測させる。
  // dataset.json の実収録（slug→校数）だけを列挙し、生成物と一覧を必ず一致させる。
  const datasetPrefCounts = metadata?.prefectures
  const prefectureApiLinks = datasetPrefCounts
    ? PREFECTURES.filter((p) => datasetPrefCounts[p.slug] != null).map((p) => ({
        slug: p.slug,
        name: p.name,
        count: Number(datasetPrefCounts[p.slug]),
      }))
    : []

  const coverage = metadata
    ? `${metadata.prefecture_count === PREFECTURES.length ? '全国 ' : ''}` +
      `${metadata.prefecture_count.toLocaleString('en-US')} 都道府県・` +
      `${metadata.school_count.toLocaleString('en-US')} 校`
    : '収録対象'

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={goBack} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">公開データセット・API</div>
      </div>
      <main id="main-content" className="content legal-content" tabIndex={-1}>
        <h1 style={{ marginTop: 0 }}>学校基本情報データセット・公開 API</h1>
        <p>{coverage}の学校基本情報を、出典へ戻れる形で公開しています。</p>
        <p><strong>{datasetClaims.claim}</strong></p>

        <h2>収録基準</h2>
        <p>
          学校公式 URL を確認できる学校と、学校・教育委員会・官公庁の一次資料へたどれる項目だけを収録します。
          出典を確認できない項目は公開側へ出しません。
        </p>
        <p>
          偏差値の編集推計は、数値だけを切り出した序列化を避けるため公開 API には含めません。
          アプリ上では方法と限界の説明と組み合わせて扱います。
        </p>

        <h2>安定エンドポイント</h2>
        <ul>
          <li><a href="/api/v1/schools.json">全都道府県: /api/v1/schools.json</a></li>
          <li><a href="/api/v1/schools/{'{prefecture}'}.json">県別: /api/v1/schools/{'{prefecture}'}.json</a></li>
          <li><a href="/api/v1/dataset.json">メタデータ: /api/v1/dataset.json</a></li>
        </ul>
        <p>
          いずれも静的 JSON です。検索条件付きリクエストや POST は提供しません。
          互換性を壊す変更が必要な場合は /api/v2/ を新設し、/api/v1/ は維持します。
        </p>

        {prefectureApiLinks.length > 0 && (
          <>
            <h2>県別エンドポイント一覧</h2>
            <p>{prefectureApiLinks.length} 件すべてを列挙します。括弧内は収録校数です。</p>
            <ul>
              {prefectureApiLinks.map((pref) => (
                <li key={pref.slug}>
                  <a href={`/api/v1/schools/${pref.slug}.json`}>
                    {pref.name}: /api/v1/schools/{pref.slug}.json
                  </a>
                  （{pref.count.toLocaleString('en-US')} 校）
                </li>
              ))}
            </ul>
          </>
        )}

        <h2>ライセンスと出典表記</h2>
        <p>
          データは <a href={datasetClaims.licenseUrl}>CC BY-SA 4.0</a> です。
          利用・再配布時は「{datasetClaims.attribution}」と表記してください。
        </p>
        <p>
          <a href="https://github.com/ishizakahiroshi/manabi-map/blob/main/DATA.md" target="_blank" rel="noopener noreferrer">
            生成方法と詳しい収録方針（DATA.md）
          </a>
        </p>

        <h2>訂正窓口</h2>
        <p>
          掲載情報の削除・訂正は <a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a> へお知らせください。
        </p>
      </main>
    </div>
  )
}
