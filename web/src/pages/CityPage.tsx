import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import type { useUserData } from '../hooks/useUserData'
import { getInitialData } from '../lib/initialData'
import {
  buildCityCounts,
  cityPagePath,
  expandPrefSchool,
  loadPrefIndex,
  selectCitySiblings,
  type CityCount,
  type PrefListSchool,
} from '../lib/prefIndex'
import { prefectureBySlug } from '../lib/prefecture'
import { useFormat } from '../hooks/useFormat'
import { trackEvent } from '../lib/analytics'
import { useSchoolChips } from '../hooks/useSchoolChips'
import { SchoolFilterChips } from '../components/SchoolFilterChips'
import { SiteFooter } from '../components/SiteFooter'
import { NotFoundPage } from './NotFoundPage'

/**
 * プリレンダー同梱（または null）から市区町村一覧の初期 state を作る。
 * sessionStorage / fetch は触らない（hydration 一致のため）。
 */
function initialCityState(
  slug: string | undefined,
  city: string | undefined,
  prefName: string | undefined,
): { schools: PrefListSchool[]; cityCounts: CityCount[] | null } {
  if (!slug || !city || !prefName) return { schools: [], cityCounts: null }
  const payload = getInitialData()?.cityPage
  if (!payload || payload.slug !== slug || payload.city !== city) {
    return { schools: [], cityCounts: null }
  }
  try {
    return {
      schools: payload.schools.map((entry) => expandPrefSchool(entry, prefName)),
      cityCounts: payload.cityCounts,
    }
  } catch {
    return { schools: [], cityCounts: null }
  }
}

interface Props {
  userData: ReturnType<typeof useUserData>
}

/**
 * /pref/:pref/:city — 市区町村ハブ（所在地ベースの一覧）。
 *
 * 掲載は**所在地の列挙**であって通学圏ではない。「◯◯市から通える高校」型の見出し・
 * 本文は書かない（学区データを保有しないため。docs/local/plan_seo-growth-strategy.md
 * §やらないこと の不変原則。verify-static-output.mjs が「から通える」を検査する）。
 *
 * 並び順は五十音順に固定する。偏差値順・倍率順のソートは実装しない
 * （ランキングサイト化の禁止線・同 §やらないこと）。
 *
 * データは県ページと同じ pref-index を読み、該当市区町村だけに絞る（専用 JSON は作らない）。
 */
export function CityPage({ userData }: Props) {
  const { pref: slug, city } = useParams()
  const navigate = useNavigate()
  const { setHome } = useApp()
  const { t } = useI18n()
  const { favorites } = userData
  const fmt = useFormat()
  const pref = slug ? prefectureBySlug(slug) : null
  const goBack = useGoBack(slug ? `/pref/${slug}` : '/schools')

  const boot = initialCityState(slug, city, pref?.name)
  const [schools, setSchools] = useState<PrefListSchool[]>(() => boot.schools)
  const [cityCounts, setCityCounts] = useState<CityCount[] | null>(() => boot.cityCounts)
  const [loading, setLoading] = useState(() => boot.cityCounts == null)
  const [error, setError] = useState<string | null>(null)
  // 直前に表示していた市区町村。切り替わったときだけ一覧をクリアする
  // （埋め込み直後に空へ落とすとちらつくため）。
  const lastKey = useRef<string | null>(boot.cityCounts != null ? `${slug}/${city}` : null)

  // 県別軽量インデックスを読み、該当市区町村だけに絞る。埋め込みの有無にかかわらず
  // 取り直す（HTML だけ古い / JSON だけ新しいズレを正典側で上書きする）。
  useEffect(() => {
    if (!slug || !pref || !city) return
    const key = `${slug}/${city}`
    const keyChanged = lastKey.current !== key
    if (keyChanged) {
      setLoading(true)
      setError(null)
      setSchools([])
      setCityCounts(null)
      lastKey.current = key
    }
    let cancelled = false
    void loadPrefIndex(slug)
      .then((payload) => {
        if (cancelled) return
        setCityCounts(buildCityCounts(payload))
        setSchools(
          payload.schools
            .filter((entry) => entry.c === city)
            .map((entry) => expandPrefSchool(entry, pref.name)),
        )
        setLoading(false)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        // 埋め込みで既に描けている市区町村の取り直し失敗では画面を潰さない。
        if (keyChanged) {
          setError('学校データの取得に失敗しました。時間をおいて再読み込みしてください。')
          setSchools([])
          setCityCounts([])
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug, pref, city])

  const chips = useSchoolChips(schools)
  const chipsClear = chips.clear

  const sorted = useMemo(() => {
    const collator = new Intl.Collator('ja')
    return schools
      .slice()
      .sort((a, b) => collator.compare(a.name_kana ?? a.name, b.name_kana ?? b.name))
  }, [schools])
  // 静的 HTML は常に全校を五十音順で出す（絞り込みは React 側の表示フィルタのみ）。
  const shown = sorted.filter(chips.matches)

  // 市区町村が切り替わったら絞り込みを持ち越さない。
  useEffect(() => {
    chipsClear()
    // chipsClear は useCallback で安定。依存に足すと参照だけで再発火する形になるため入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, city])

  const siblings = useMemo(
    () => (cityCounts && city ? selectCitySiblings(cityCounts, city) : []),
    [cityCounts, city],
  )

  /** [この地域を地図で見る] の中心。市区町村内の全校の重心（追加データ不要）。 */
  const center = useMemo(() => {
    const located = schools.filter((s) => s.latitude != null && s.longitude != null)
    if (located.length === 0) return null
    return {
      lat: located.reduce((sum, s) => sum + (s.latitude ?? 0), 0) / located.length,
      lng: located.reduce((sum, s) => sum + (s.longitude ?? 0), 0) / located.length,
    }
  }, [schools])

  if (!pref || !city) return <NotFoundPage />
  // 存在しない市区町村（手打ち URL・旧表記）は 404。読み込み前は判定しない。
  if (cityCounts != null && cityCounts.length > 0 && !cityCounts.some((entry) => entry.c === city)) {
    return <NotFoundPage />
  }

  const openSchool = (school: PrefListSchool) => {
    trackEvent('search', { source: 'city_page' })
    if (school.latitude != null && school.longitude != null) {
      setHome({ label: school.name, lat: school.latitude, lng: school.longitude })
    }
    navigate(`/school/${school.id}`)
  }

  const openMap = () => {
    if (!center) return
    setHome({ label: city, lat: center.lat, lng: center.lng })
    navigate('/map')
  }

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={goBack} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{t('cityPage.title', { city, n: sorted.length })}</div>
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
          <a
            href="/schools/"
            onClick={(e) => {
              e.preventDefault()
              navigate('/schools')
            }}
          >
            {t('schoolsHub.title')}
          </a>
          <span aria-hidden="true"> › </span>
          <a
            href={`/pref/${pref.slug}/`}
            onClick={(e) => {
              e.preventDefault()
              navigate(`/pref/${pref.slug}`)
            }}
          >
            {pref.name}
          </a>
          <span aria-hidden="true"> › </span>
          <span>{city}</span>
        </nav>

        <h1 className="hub-title">{t('cityPage.title', { city, n: sorted.length })}</h1>
        <p>{t('cityPage.context', { pref: pref.name, city, n: sorted.length })}</p>
        <p className="mini-hint soft">{t('cityPage.notice')}</p>

        {loading && <div className="mini-hint">{t('common.loading')}</div>}
        {error && <div className="mini-hint bad" role="alert">{error}</div>}

        {!loading && !error && (
          <>
            <SchoolFilterChips
              chips={chips.chips}
              active={chips.active}
              total={sorted.length}
              shown={shown.length}
              onClear={chipsClear}
            />

            <ul className="city-school-list flat">
              {shown.map((s) => {
                const status = fmt.listStatusLabel(s)
                return (
                  <li key={s.id}>
                    <a
                      href={`/school/${s.id}/`}
                      onClick={(e) => {
                        e.preventDefault()
                        openSchool(s)
                      }}
                    >
                      {s.name}
                      {favorites[s.id] && (
                        <span
                          className="city-school-fav"
                          role="img"
                          aria-label={t('prefPage.favorited')}
                        >
                          ★
                        </span>
                      )}
                      <span className="city-school-meta">
                        {fmt.ownFull(s)}・{s.course_times.map((c) => fmt.courseFull(c)).join('・')}
                        {status ? `〔${status}〕` : ''}
                      </span>
                    </a>
                  </li>
                )
              })}
              {shown.length === 0 && (
                <li className="mini-hint soft">
                  {chips.active ? t('prefPage.cityAllFiltered') : t('cityPage.empty')}
                </li>
              )}
            </ul>

            {center && (
              <p className="chip-row">
                <button type="button" className="chip" onClick={openMap}>
                  {t('cityPage.mapLink')}
                </button>
              </p>
            )}

            {siblings.length > 0 && (
              <nav className="city-nearby" aria-label={t('cityPage.nearbyHeading')}>
                <h2 className="city-nearby-heading">{t('cityPage.nearbyHeading')}</h2>
                <ul>
                  {siblings.map((entry) => (
                    <li key={entry.c}>
                      <a
                        href={cityPagePath(pref.slug, entry.c)}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(cityPagePath(pref.slug, entry.c))
                        }}
                      >
                        {t('cityPage.nearbyLink', { city: entry.c, n: entry.n })}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </>
        )}

        <p>
          <a
            href={`/pref/${pref.slug}/`}
            onClick={(e) => {
              e.preventDefault()
              navigate(`/pref/${pref.slug}`)
            }}
          >
            {t('cityPage.backToPref', { pref: pref.name })}
          </a>
        </p>
        <SiteFooter />
      </main>
    </div>
  )
}
