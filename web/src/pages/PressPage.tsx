import { useNavigate } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'

/**
 * /press — メディア関係者・教育関係者向けのプレスキット / 基礎情報ページ。
 * 記者・行政職員が読む前提。既存の screen/header/content パターンに揃える。
 */
export function PressPage() {
  const navigate = useNavigate()
  const { t } = useI18n()

  type KitItem = { label: string; href: string; note: string; ready?: boolean }
  const distributionItems: KitItem[] = [
    {
      label: '掲示ポスター（A3 縦・PDF）',
      href: '/press/manabi-map-poster.pdf',
      note: 'ダウンロード',
      ready: true,
    },
    {
      label: '保護者配布・面談用 handout（A4 縦・PDF）',
      href: '/press/manabi-map-handout.pdf',
      note: 'ダウンロード',
      ready: true,
    },
  ]
  const kitItems: KitItem[] = [
    { label: 'プレスリリース PDF', href: '/press/press-release.pdf', note: '準備中' },
    { label: 'ロゴ一式（SVG / PNG）', href: '/press/logo-pack.zip', note: '準備中' },
    { label: 'スクリーンショット集', href: '/press/screenshots.zip', note: '準備中' },
  ]

  const renderKitList = (items: KitItem[]) => (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {items.map((item) => {
        const badge = (
          <span
            aria-disabled={item.ready ? undefined : 'true'}
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: item.ready ? 'var(--accent)' : 'var(--line)',
              color: item.ready ? '#fff' : 'var(--ink-soft)',
              fontSize: '0.85em',
              whiteSpace: 'nowrap',
              fontWeight: item.ready ? 700 : 400,
              textDecoration: 'none',
            }}
          >
            {item.note}
          </span>
        )
        return (
          <li
            key={item.href}
            style={{
              padding: '12px 14px',
              marginBottom: 8,
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--card)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span>
              <b>{item.label}</b>
              <br />
              <small style={{ color: 'var(--ink-soft)' }}>{item.href}</small>
            </span>
            {item.ready ? (
              <a href={item.href} download style={{ textDecoration: 'none' }}>
                {badge}
              </a>
            ) : (
              badge
            )}
          </li>
        )
      })}
    </ul>
  )

  const basics: Array<[string, React.ReactNode]> = [
    ['サービス名', 'Manabi Map（まなびマップ）'],
    ['URL', <a key="u" href="https://manabi-map.app" target="_blank" rel="noopener noreferrer">https://manabi-map.app</a>],
    ['現行バージョン', <span key="v">v{__APP_VERSION__}</span>],
    ['初回公開', '2026-07-05（群馬県版から段階的に全国展開中）'],
    ['開発者', 'ishizakahiroshi（個人 OSS）'],
    ['ライセンス', 'コード AGPL-3.0 / データ CC BY-SA 4.0'],
    ['料金', '無料（広告は進路・教育関連のみ控えめに掲載）'],
    ['対象年齢', '中学生・高校生とその保護者'],
  ]

  const faqs: Array<{ q: string; a: React.ReactNode }> = [
    {
      q: '商用サイトの偏差値を転載していますか？',
      a: 'いいえ。公的資料（学校基本調査・各校公表資料等）に基づく Manabi Map 独自推計です。商用偏差値サイトからの数値転載は行いません。',
    },
    {
      q: '学校側から掲載情報の修正を依頼できますか？',
      a: <>できます。<a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a> にご連絡ください（24 時間以内に受信確認 / 7 日以内に対応）。</>,
    },
    {
      q: '広告は入っていますか？',
      a: '進路・教育関連（学習塾・通信制高校・大学・専門学校・通信教育・模試など）に限定して控えめに掲載しています。無差別アドネットワーク（AdSense 等のランダム配信）や消費者金融・ギャンブル等の広告は掲載しません。',
    },
    {
      q: 'オープンソースですか？',
      a: <>はい。コードは AGPL-3.0、収録データは CC BY-SA 4.0 で公開しています。ソースコードは <a href="https://github.com/ishizakahiroshi/manabi-map" target="_blank" rel="noopener noreferrer">GitHub</a> で公開中です。</>,
    },
    {
      q: 'ネイティブアプリ版はありますか？',
      a: 'ありません。Web 完結（PWA）で運営しています。ホーム画面追加でアプリのように使えます。',
    },
  ]

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">配布素材・プレスキット</div>
      </div>
      <main
        id="main-content"
        className="content legal-content"
        tabIndex={-1}
        style={{ paddingBottom: 24 }}
      >
        <h1 style={{ marginTop: 0 }}>メディア関係者・教育関係者の方へ</h1>
        <p>
          Manabi Map（まなびマップ）は、<b>親子で使う「学校選びの地図ノート」</b>です。
          住所を入れると通える高校が地図に表示され、気になる学校をお気に入り保存し、
          文化祭・説明会・通学経路・親子の感想を学校ごとに家族でメモできます。
        </p>
        <p>
          偏差値の序列づけや合否煽りではなく、
          <b>中学生と保護者が納得して進路を選ぶための管理ツール</b>を目指した個人 OSS プロジェクトです。
          広告は進路・教育関連のみ、無差別アドネットワークは使用しません。
        </p>

        <h2>学校・保護者向け 配布素材</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9em' }}>
          進路指導部の先生や保護者へ紹介いただく際に、ご自由にダウンロード・印刷・配布いただけます（改変は不可）。
          A3 掲示ポスターは職員室・進路指導室の掲示に、A4 handout は面談・保護者会での手渡しに使えます。
        </p>
        {renderKitList(distributionItems)}

        <h2>プレスキット ダウンロード</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9em' }}>
          記者・行政関係者向けの素材は準備中です。公開まで少々お待ちください。急ぎの場合は
          <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a> までご連絡ください。
        </p>
        {renderKitList(kitItems)}

        <h2>サービス基礎情報</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0 16px' }}>
          <tbody>
            {basics.map(([k, v]) => (
              <tr key={k}>
                <th
                  scope="row"
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    border: '1px solid var(--line)',
                    background: 'var(--card)',
                    width: '35%',
                    verticalAlign: 'top',
                    fontWeight: 600,
                  }}
                >
                  {k}
                </th>
                <td style={{ padding: '10px 12px', border: '1px solid var(--line)' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>取材・お問い合わせ</h2>
        <ul>
          <li>
            一般のお問い合わせ・取材依頼:{' '}
            <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a>
          </li>
          <li>
            掲載情報の削除・訂正要請:{' '}
            <a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a>
            （24 時間以内に受信確認 / 7 日以内に対応）
          </li>
        </ul>

        <h2>開発者プロフィール</h2>
        <p>
          ishizakahiroshi — 個人 OSS 開発者。Manabi Map を含む複数の教育・生活向け Web サービスを
          個人で企画・実装・運営しています。取材・登壇のご相談は
          <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a> までお願いします。
        </p>

        <h2>よくある質問</h2>
        <dl>
          {faqs.map((f) => (
            <div key={f.q} style={{ marginBottom: 14 }}>
              <dt style={{ fontWeight: 600, marginBottom: 4 }}>Q. {f.q}</dt>
              <dd style={{ margin: '0 0 0 1em' }}>A. {f.a}</dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  )
}
