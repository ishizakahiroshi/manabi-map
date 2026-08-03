import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'
import { PREFECTURES, REGION_KEYS } from '../lib/prefecture'
import { loadSearchIndexes } from '../lib/searchIndex'
import { SiteFooter } from '../components/SiteFooter'

/**
 * /schools — 全域ハブ（都道府県一覧）。
 * 初回直リンクはプリレンダー HTML（scripts/gen-seo-pages.mjs）が出るため、
 * ここは SPA 内遷移と mount 後の描画を担当する（白紙防止）。
 * 校数は軽量な校名索引から数える（schools.json 全体は読まない）。
 */
export function SchoolsHubPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [counts, setCounts] = useState<Map<string, number> | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadSearchIndexes()
      .then(({ schools }) => {
        if (cancelled) return
        const byPref = new Map<string, number>()
        for (const s of schools) byPref.set(s.pref, (byPref.get(s.pref) ?? 0) + 1)
        setCounts(byPref)
      })
      .catch(() => {
        // 件数は補助情報なので、索引が取れなくても都道府県リンク自体は出す
        if (!cancelled) setCounts(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{t('schoolsHub.title')}</div>
      </div>
      <main id="main-content" className="content hub-content" tabIndex={-1}>
        <nav className="breadcrumb" aria-label={t('prefPage.breadcrumbLabel')}>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault()
              navigate('/')
            }}
          >
            {t('prefPage.breadcrumbTop')}
          </a>
          <span aria-hidden="true"> › </span>
          <span>{t('schoolsHub.title')}</span>
        </nav>
        <h1 className="hub-title">{t('schoolsHub.title')}</h1>
        <p className="mini-hint soft">{t('schoolsHub.note')}</p>
        {REGION_KEYS.map((region) => {
          const prefs = PREFECTURES.filter((p) => p.region === region)
          if (prefs.length === 0) return null
          return (
            <section key={region} className="hub-region">
              <h2>{t(`regions.${region}`)}</h2>
              <ul className="hub-pref-list">
                {prefs.map((p) => {
                  const count = counts?.get(p.name)
                  return (
                    <li key={p.slug}>
                      <a
                        href={`/pref/${p.slug}/`}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(`/pref/${p.slug}`)
                        }}
                      >
                        {count != null && count > 0
                          ? t('schoolsHub.prefLink', { pref: p.name, n: count })
                          : p.name}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
        <SiteFooter />
      </main>
    </div>
  )
}
