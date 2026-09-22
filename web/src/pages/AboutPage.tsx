import { useNavigate } from 'react-router-dom'
import datasetClaims from '../../data/dataset-claims.json'
import siteFooterLinks from '../../data/site-footer-links.json'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'

const DEVELOPER_SITE_URL = 'https://ishizakahiroshi.com/'
const REPO_URL = 'https://github.com/ishizakahiroshi/manabi-map'

/**
 * /about — 保護者・中高生向けの「このサービスについて」。
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

        <h2>できること</h2>
        <ul>
          <li>住所を入れると、通える範囲の高校が地図に表示されます。</li>
          <li>気になる学校をお気に入りに保存し、あとで見比べられます。</li>
          <li>文化祭・説明会の感想や通学経路のメモを、学校ごとに残して家族で共有できます。</li>
        </ul>

        <h2>大切にしていること</h2>
        <ul>
          <li>学校を偏差値で順位づけするランキングサイトにはしません。</li>
          <li>
            偏差値の目安は、公的資料を参考にした Manabi Map の編集推計です。公式の偏差値や合格判定ではありません。
            根拠と限界は {internalLink('/legal/deviation-methodology')} で公開しています。
          </li>
          <li>
            利用は無料です。広告は進路・教育に関係するものだけを「PR」と明示して控えめに載せ、
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
