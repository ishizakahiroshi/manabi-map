import { useNavigate } from 'react-router-dom'
import datasetClaims from '../../data/dataset-claims.json'
import siteFooterLinks from '../../data/site-footer-links.json'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'

const DEVELOPER_SITE_URL = 'https://ishizakahiroshi.com/'
const REPO_URL = 'https://github.com/ishizakahiroshi/manabi-map'

/**
 * /about — 保護者・中高生向けの「このサービスについて」。使い方（旧「使い方 / ヘルプ」）もここに置く。
 * 記者・学校関係者向けの基礎情報と配布素材は /press が担う（ここは利用者向けの紹介に絞る）。
 */
export function AboutPage() {
  const navigate = useNavigate()
  const goBack = useGoBack('/')
  const { t, locale } = useI18n()

  // 外向けページの表示名は web/data/site-footer-links.json が正本（フッター・サイドバーと同じ実体）。
  const internalLink = (path: string) => (
    <a href={`${path}/`} onClick={(e) => { e.preventDefault(); navigate(path) }}>
      {siteFooterLinks.links.find((link) => link.path === path)?.[locale] ?? ''}
    </a>
  )

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={goBack} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">このサービスについて</div>
      </div>
      <main
        id="main-content"
        className="content legal-content"
        tabIndex={-1}
        style={{ paddingBottom: 24 }}
      >
        <h1 style={{ marginTop: 0 }}>Manabi Map（まなびマップ）について</h1>
        <p>
          Manabi Map は、<b>親子で使う「学校選びの地図ノート」</b>です。
          中学生と保護者が、話し合いながら納得して進路を選べるように作っています。
        </p>
        {/* 初めての人向けの要点だけを置く。ライセンス・バージョン等の技術的な基礎情報は /press の表に任せる */}
        <ul>
          <li><b>料金</b>: 無料（会員登録をしなくても地図や学校の情報を見られます）</li>
          <li><b>対象</b>: 中学生・高校生とその保護者</li>
          <li><b>対応地域</b>: 全国 47 都道府県（2026 年 7 月から公開）</li>
          <li><b>運営</b>: 個人で開発・運営しています（くわしくは下の「作っている人」へ）</li>
        </ul>

        <h2>使い方</h2>
        <ol>
          <li>
            <b>地点を検索する</b> — トップページで住所・地名・学校名などを検索すると、周辺の高校が地図に表示されます。
          </li>
          <li>
            <b>気になる学校を保存する</b> — 地図上の学校をタップして、お気に入りに追加します。保存した学校はあとで見比べられます。
          </li>
          <li>
            <b>家族でメモを共有する</b> — 文化祭や説明会で見聞きしたこと、通学経路の感想などを学校ごとに書き込み、家族で共有できます。
          </li>
        </ol>
        <p>
          ログインは LINE・Google・匿名から選べます。匿名で始めたあとに LINE または Google を連携すると、
          それまでのお気に入りやメモを引き継げます。同じアカウントでログインすれば、PC とスマホでメモが同期します。
        </p>
        <p>
          アプリのインストールは不要です。ブラウザのメニューから「ホーム画面に追加」すると、アプリのように開けます。
          学校見学の準備などは {internalLink('/guide/school-visit')} で紹介しています。
        </p>

        <h2>大切にしていること</h2>
        <ul>
          <li>学校を偏差値で順位づけするランキングサイトにはしません。</li>
          <li>
            偏差値の目安は、公的資料を参考にした Manabi Map の編集推計です。公式の偏差値や合格判定ではありません。
            根拠と限界は {internalLink('/legal/deviation-methodology')} で公開しています。
          </li>
          <li>
            広告は進路・教育に関係するものだけを「広告（PR）」と明示して控えめに載せ、
            無差別に配信される広告は使いません。
          </li>
        </ul>

        <h2>学校データと個人情報</h2>
        <p>
          収録データは<b>{datasetClaims.claim}</b>を方針としています。
          出典と収録基準は {internalLink('/data')} で確認できます。
        </p>
        <p>
          お気に入りやメモなど、入力いただいた情報の扱いは {internalLink('/legal/privacy')} にまとめています。
        </p>

        <h2>作っている人</h2>
        <p>
          ishizakahiroshi が個人で企画・開発・運営しています。ほかの制作物や経歴は公式サイトで紹介しています。
        </p>
        <ul>
          <li>
            公式サイト:{' '}
            <a href={DEVELOPER_SITE_URL} target="_blank" rel="noopener noreferrer">{DEVELOPER_SITE_URL}</a>
          </li>
          <li>
            ソースコード（オープンソース）:{' '}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          </li>
        </ul>

        <h2>お問い合わせ</h2>
        <ul>
          <li>
            ご意見・ご質問:{' '}
            <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a>
          </li>
          <li>
            掲載情報の削除・訂正:{' '}
            <a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a>
          </li>
        </ul>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9em' }}>
          報道・学校関係者の方向けの基礎情報と配布素材は {internalLink('/press')} にあります。
        </p>
      </main>
    </div>
  )
}
