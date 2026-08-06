import { useEffect, useState } from 'react'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import { PREFECTURES } from '../lib/prefecture'

type DatasetMetadata = {
  school_count: number
  prefecture_count: number
}

const DATASET_CLAIM = '一次資料 100%・出典明示 100%・商用サイトからの転載ゼロ'

export function DataPage() {
  const goBack = useGoBack('/')
  const { t } = useI18n()
  const [metadata, setMetadata] = useState<DatasetMetadata | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/v1/dataset.json')
      .then((response) => {
        if (!response.ok) throw new Error(`dataset metadata: HTTP ${response.status}`)
        return response.json() as Promise<DatasetMetadata>
      })
      .then((value) => {
        if (active) setMetadata(value)
      })
      .catch(() => {
        // 件数が読めなくても、API URL・方針・訂正窓口は表示し続ける。
      })
    return () => {
      active = false
    }
  }, [])

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
        <p><strong>{DATASET_CLAIM}</strong></p>

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
          <li><a href="/api/v1/schools/gunma.json">県別の例: /api/v1/schools/gunma.json</a></li>
          <li><a href="/api/v1/dataset.json">メタデータ: /api/v1/dataset.json</a></li>
        </ul>
        <p>
          いずれも静的 JSON です。検索条件付きリクエストや POST は提供しません。
          互換性を壊す変更が必要な場合は /api/v2/ を新設し、/api/v1/ は維持します。
        </p>

        <h2>ライセンスと出典表記</h2>
        <p>
          データは <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a> です。
          利用・再配布時は「出典: Manabi Map（まなびマップ） https://manabi-map.app （CC BY-SA 4.0）」と表記してください。
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
