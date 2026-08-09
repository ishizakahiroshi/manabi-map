import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import type { useUserData } from '../hooks/useUserData'
import { getInitialData } from '../lib/initialData'
import {
  cityPagePath,
  expandPrefIndex,
  loadPrefIndex,
  type PrefListSchool,
} from '../lib/prefIndex'
import { normalizeForMatch } from '../lib/searchIndex'
import { prefectureBySlug } from '../lib/prefecture'
import { useFormat } from '../hooks/useFormat'
import { trackEvent } from '../lib/analytics'
import { useSchoolChips } from '../hooks/useSchoolChips'
import { SchoolFilterChips } from '../components/SchoolFilterChips'
import { SiteFooter } from '../components/SiteFooter'
import { NotFoundPage } from './NotFoundPage'

/** 解決不能校の受け皿（scripts/lib/municipalities.mjs の UNRESOLVED_CITY_LABEL と同値）。 */
const UNRESOLVED_CITY = 'その他'
const viewStateKey = (slug: string) => `manabi:pref-view:${slug}`
type PrefViewState = { open: string[]; scroll: number }

function readPrefViewState(slug: string | undefined): PrefViewState {
  if (!slug || typeof window === 'undefined') return { open: [], scroll: 0 }
  try {
    const raw = window.sessionStorage.getItem(viewStateKey(slug))
    if (!raw) return { open: [], scroll: 0 }
    const parsed = JSON.parse(raw) as Partial<PrefViewState>
    return {
      open: Array.isArray(parsed.open)
        ? parsed.open.filter((label): label is string => typeof label === 'string')
        : [],
      scroll: typeof parsed.scroll === 'number' && Number.isFinite(parsed.scroll)
        ? Math.max(0, parsed.scroll)
        : 0,
    }
  } catch {
    return { open: [], scroll: 0 }
  }
}

function savePrefViewState(slug: string, openCities: Set<string>, scroll: number): void {
  try {
    window.sessionStorage.setItem(
      viewStateKey(slug),
      JSON.stringify({ open: [...openCities], scroll }),
    )
  } catch {
    // sessionStorage unavailable or full: view-state persistence is best effort
  }
}

/**
 * プリレンダー同梱（または null）から県一覧の初期 state を作る。
 * sessionStorage / fetch は触らない（hydration 一致のため）。
 */
function initialPrefState(slug: string | undefined, prefName: string | undefined): {
  schools: PrefListSchool[]
  cityOrder: string[] | null
} {
  if (!slug || !prefName) return { schools: [], cityOrder: null }
  const payload = getInitialData()?.prefPage
  if (!payload || payload.slug !== slug) return { schools: [], cityOrder: null }
  try {
    return {
      schools: expandPrefIndex(payload, prefName),
      cityOrder: payload.cities,
    }
  } catch {
    return { schools: [], cityOrder: null }
  }
}

interface Props {
  userData: ReturnType<typeof useUserData>
}

/**
 * /pref/:pref — 都道府県ハブ（一覧）。
 * 全件 schools.json は読まず、県別軽量インデックス（pref-index）だけで描く
 * （plan_ssr-hydration_c3_initial-data.md）。地図へ遷移したときに初めて全件を取る。
 * 並び順は市区町村コード順 → 同一市区町村内は五十音順に固定する。
 * 偏差値順・倍率順のソートは実装しない（ランキングサイト化の禁止線・
 * docs/local/plan_seo-growth-strategy.md §やらないこと）。
 */
export function PrefecturePage({ userData }: Props) {
  const { pref: slug } = useParams()
  const navigate = useNavigate()
  const goBack = useGoBack('/schools')
  const location = useLocation()
  const navigationType = useNavigationType()
  const { setHome } = useApp()
  const { t } = useI18n()
  const { favorites } = userData
  const fmt = useFormat()
  const pref = slug ? prefectureBySlug(slug) : null

  const boot = initialPrefState(slug, pref?.name)
  const [prefSchools, setPrefSchools] = useState<PrefListSchool[]>(() => boot.schools)
  const [cityOrder, setCityOrder] = useState<string[] | null>(() => boot.cityOrder)
  const [loading, setLoading] = useState(() => boot.cityOrder == null)
  const [error, setError] = useState<string | null>(null)
  const contentRef = useRef<HTMLElement>(null)
  const storedViewStateRef = useRef<PrefViewState | null>(null)
  const viewStateSlugRef = useRef(slug)
  const restoredFor = useRef<string | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  // 初回 render は sessionStorage を読まない（SSR と一致させる）。effect で復元する。
  const [openCities, setOpenCities] = useState<Set<string>>(() => new Set())
  const openCitiesRef = useRef(openCities)
  openCitiesRef.current = openCities
  /**
   * 戻る操作（POP）でこの画面へ着いたときは、URL hash よりも保存済みの閲覧位置を優先する。
   * 初回 render では false 固定。effect で sessionStorage を見て立てる。
   */
  const preferStoredScroll = useRef(false)
  const chips = useSchoolChips(prefSchools)
  const chipsClear = chips.clear
  const [q, setQ] = useState('')
  const scrolledFor = useRef<string | null>(null)
  // 貼り付いた見出しの判定に実測値を使う（CSS の --city-jump-h と二重管理しない）
  const jumpRef = useRef<HTMLElement>(null)
  // 直前に表示していた slug。切り替わったときだけ一覧をクリアする
  // （埋め込み直後に setPrefSchools([]) するとちらつく）。
  // 埋め込みはビルド時点の値なので、正典は常に pref-index JSON 側。hydration 後に取り直す。
  const lastPrefSlug = useRef<string | null>(boot.cityOrder != null ? (slug ?? null) : null)

  // 県別軽量インデックスを読む。埋め込みの有無にかかわらず取り直す
  // （HTML だけ古い / JSON だけ新しいズレを正典側で上書きする）。
  // slug 切替時は前の県の一覧を残さない（見出しだけ新県・中身が旧県になるのを防ぐ）。
  useEffect(() => {
    if (!slug || !pref) return
    const slugChanged = lastPrefSlug.current !== slug
    if (slugChanged) {
      setLoading(true)
      setError(null)
      setPrefSchools([])
      setCityOrder(null)
      lastPrefSlug.current = slug
    }
    let cancelled = false
    void loadPrefIndex(slug)
      .then((payload) => {
        if (cancelled) return
        setPrefSchools(expandPrefIndex(payload, pref.name))
        setCityOrder(payload.cities)
        setLoading(false)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        // 埋め込みで既に描けている slug の取り直し失敗では画面を潰さない。
        if (slugChanged) {
          setError('学校データの取得に失敗しました。時間をおいて再読み込みしてください。')
          setPrefSchools([])
          setCityOrder([])
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [slug, pref])

  // 開閉・スクロール位置は effect で復元（初回 render では触らない）
  useEffect(() => {
    const state = readPrefViewState(slug)
    storedViewStateRef.current = state
    setOpenCities(new Set(state.open))
    preferStoredScroll.current = navigationType === 'POP' && state.scroll > 0
  }, [slug, navigationType])

  const groups = useMemo(() => {
    if (cityOrder == null) return []
    const byCity = new Map<string, PrefListSchool[]>()
    for (const school of prefSchools) {
      const city = school.city ?? UNRESOLVED_CITY
      const list = byCity.get(city) ?? []
      list.push(school)
      byCity.set(city, list)
    }
    const collator = new Intl.Collator('ja')
    // cityOrder に載っている市区町村だけが専用ページを持つ（「その他」＝解決不能の
    // 受け皿にはページが無いので、リンクを出すとリンク切れになる）。
    const known = new Set(cityOrder)
    const orderedLabels = [
      ...cityOrder.filter((c) => byCity.has(c)),
      ...[...byCity.keys()].filter((c) => !known.has(c)).sort(collator.compare),
    ]
    return orderedLabels.map((label) => {
      const list = (byCity.get(label) ?? []).slice()
      list.sort((a, b) => collator.compare(a.name_kana ?? a.name, b.name_kana ?? b.name))
      return { label, schools: list, hasPage: known.has(label) }
    })
  }, [prefSchools, cityOrder])

  /**
   * 校名しぼりこみ用の正規化済み文字列（校名＋ふりがな）。
   * 1 文字入力するたびに 440 校ぶんの正規化を走らせないよう、県の学校集合が変わった時だけ作る。
   */
  const haystackById = useMemo(() => {
    const map = new Map<string, string>()
    for (const school of prefSchools) {
      map.set(school.id, normalizeForMatch(`${school.name}${school.name_kana ?? ''}`))
    }
    return map
  }, [prefSchools])

  // #<市区町村> アンカーで着地・遷移したら該当セクションを自動展開してスクロールする
  useEffect(() => {
    if (!location.hash || groups.length === 0) return
    // 不正な %-エンコード（#100% 等の手打ち URL）で decodeURIComponent が throw し
    // 画面全体が ErrorBoundary に落ちるのを防ぐ（リロードしても hash が残り復帰不能になる）
    let target: string
    try {
      target = decodeURIComponent(location.hash.slice(1))
    } catch {
      return
    }
    if (!groups.some((g) => g.label === target)) return
    setOpenCities((prev) => (prev.has(target) ? prev : new Set(prev).add(target)))
    if (scrolledFor.current !== location.hash) {
      scrolledFor.current = location.hash
      // 戻る操作で着いた時は見出しへ飛ばさない（保存済みの閲覧位置を復元する側に任せる）
      if (!preferStoredScroll.current) {
        requestAnimationFrame(() => {
          document.getElementById(target)?.scrollIntoView({ block: 'start' })
        })
      }
    }
  }, [location.hash, groups])

  /**
   * ジャンプバーの実高を CSS 変数へ流す。貼り付く見出しの top とアンカー着地の
   * scroll-margin-top がこれを見る（--city-jump-h）。
   */
  useEffect(() => {
    const bar = jumpRef.current
    const host = bar?.closest('.content')
    if (!bar || !(host instanceof HTMLElement)) return
    const apply = () => {
      host.style.setProperty('--city-jump-h', `${Math.round(bar.getBoundingClientRect().height)}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [groups.length])

  /**
   * hash 着地（市区町村ジャンプ・アンカー付き直リンク）は見出しへスクロールさせるため復元しない。
   * ただし戻る操作で着いた場合は保存位置を優先するので、その時はスキップしない。
   */
  const skipScrollRestore = Boolean(location.hash) && !preferStoredScroll.current

  // 同じコンポーネントのまま県パラメータだけが変わる場合も、県ごとの状態を混ぜない
  useEffect(() => {
    if (viewStateSlugRef.current === slug) return
    viewStateSlugRef.current = slug
    restoredFor.current = null
    scrolledFor.current = null
    chipsClear()
    setQ('')
    // chipsClear は useCallback で安定。依存に足すと参照だけで再発火する形になるため入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // 市区町村の開閉状態を、現在のスクロール位置と一緒に県別へ保存する
  useEffect(() => {
    if (!pref || viewStateSlugRef.current !== slug) return
    const currentScroll = contentRef.current?.scrollTop
    const storedScroll = storedViewStateRef.current?.scroll ?? 0
    // 復元を待たない経路（hash 着地）と、復元が済んだ後は現在位置。
    // 復元前に保存すると、まだ 0 のスクロール位置で保存値を潰してしまう。
    const scroll =
      skipScrollRestore || restoredFor.current === pref.slug ? currentScroll ?? 0 : storedScroll
    savePrefViewState(pref.slug, openCities, scroll)
  }, [skipScrollRestore, openCities, pref, slug])

  // 保存済みスクロール位置は、一覧が描画されてから一度だけ復元する
  useEffect(() => {
    if (
      !pref ||
      viewStateSlugRef.current !== slug ||
      groups.length === 0 ||
      skipScrollRestore ||
      restoredFor.current === pref.slug
    ) return
    const savedScroll = storedViewStateRef.current?.scroll ?? 0
    const frame = requestAnimationFrame(() => {
      const content = contentRef.current
      if (!content) return
      restoredFor.current = pref.slug
      content.scrollTop = savedScroll
      savePrefViewState(pref.slug, openCitiesRef.current, savedScroll)
    })
    return () => cancelAnimationFrame(frame)
  }, [groups.length, skipScrollRestore, pref, slug])

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const handleScroll = () => {
    if (scrollFrameRef.current != null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      if (!pref || !contentRef.current) return
      savePrefViewState(pref.slug, openCitiesRef.current, contentRef.current.scrollTop)
    })
  }

  if (!pref) return <NotFoundPage />

  const shownCount = prefSchools.filter(chips.matches).length

  // 校名しぼりこみ。見出し（市区町村名）にも当てるので「文京」で文京区の 25 校がまとめて出る。
  const query = normalizeForMatch(q.trim())
  const queryActive = query.length > 0
  const visibleGroups = groups
    .map((g) => {
      const cityHit = queryActive && normalizeForMatch(g.label).includes(query)
      return {
        label: g.label,
        hasPage: g.hasPage,
        total: g.schools.length,
        schools: g.schools.filter(
          (s) =>
            chips.matches(s) &&
            (!queryActive || cityHit || (haystackById.get(s.id) ?? '').includes(query)),
        ),
      }
    })
    // 検索中は 0 件の市区町村ごと畳む（空の見出しを 58 個スクロールさせない）
    .filter((g) => !queryActive || g.schools.length > 0)
  const queryHits = visibleGroups.reduce((n, g) => n + g.schools.length, 0)
  /** 検索中は一致した市区町村を開いたまま固定する（結果が畳まれて見えなくならないように）。 */
  const isOpen = (label: string) => queryActive || openCities.has(label)

  const openSchool = (school: PrefListSchool) => {
    trackEvent('search', { source: 'pref_page' })
    if (school.latitude != null && school.longitude != null) {
      setHome({ label: school.name, lat: school.latitude, lng: school.longitude })
    }
    navigate(`/school/${school.id}`)
  }

  const toggleCity = (label: string) => {
    setOpenCities((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  /**
   * details の開閉を React state へ同期しつつ、「貼り付いた見出しから畳んだ」時だけ見出しへ戻す。
   * 途中で畳むと詰まった高さのぶんスクロールが下へ飛び、読んでいた場所を失うため。
   * 画面内に見えている見出しを畳んだ時（＝ジャンプバーより下にある時）は動かさない。
   */
  const handleToggle = (label: string, el: HTMLDetailsElement) => {
    if (el.open === isOpen(label)) return
    if (queryActive) {
      // 検索中は開いた状態が正。open は props 由来で自動再同期されないので DOM 側を戻す
      el.open = true
      return
    }
    toggleCity(label)
    const jumpBottom = jumpRef.current?.getBoundingClientRect().bottom ?? 0
    if (!el.open && el.getBoundingClientRect().top < jumpBottom) {
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }))
    }
  }

  const collapseAll = () => {
    setOpenCities(new Set())
    // 上の区が畳まれた分だけ下へ飛ぶので、一覧の先頭へ戻す
    const first = visibleGroups[0]?.label
    if (first) {
      requestAnimationFrame(() => {
        document.getElementById(first)?.scrollIntoView({ block: 'start' })
      })
    }
  }

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={goBack} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{t('prefPage.title', { pref: pref.name, n: prefSchools.length })}</div>
      </div>
      <main
        id="main-content"
        className="content hub-content"
        tabIndex={-1}
        ref={contentRef}
        onScroll={handleScroll}
      >
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
          <span>{pref.name}</span>
        </nav>

        <h1 className="hub-title">{t('prefPage.title', { pref: pref.name, n: prefSchools.length })}</h1>
        <p className="mini-hint soft">{t('prefPage.notice')}</p>

        {loading && <div className="mini-hint">{t('common.loading')}</div>}
        {error && <div className="mini-hint bad" role="alert">{error}</div>}

        {!loading && !error && (
          <>
            <div className="pref-search">
              <label htmlFor="pref-q" className="form-label">
                {t('prefPage.searchLabel')}
              </label>
              <div className="q-wrap">
                <input
                  id="pref-q"
                  className="input"
                  autoComplete="off"
                  placeholder={t('prefPage.searchPlaceholder')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                {q && (
                  <button
                    type="button"
                    className="q-clear"
                    onClick={() => setQ('')}
                    title={t('common.clear')}
                    aria-label={t('common.clear')}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            {queryActive && (
              <div className="mini-hint" aria-live="polite">
                {queryHits > 0
                  ? t('prefPage.searchResult', { q: q.trim(), n: queryHits })
                  : t('prefPage.searchNoResults', { q: q.trim() })}
              </div>
            )}

            <SchoolFilterChips
              chips={chips.chips}
              active={chips.active}
              total={prefSchools.length}
              shown={shownCount}
              onClear={chips.clear}
            />

            {/* 0 件でも要素は残す（ref と ResizeObserver を付け替えないため）。高さ 0 は
                --city-jump-h: 0px として正しく効き、貼り付く見出しが可視領域の上端に載る。 */}
            <nav
              className={`city-jump ${visibleGroups.length === 0 ? 'empty' : ''}`}
              aria-label={t('prefPage.jumpLabel')}
              ref={jumpRef}
            >
              {visibleGroups.map((g) => (
                <a
                  key={g.label}
                  href={`#${encodeURIComponent(g.label)}`}
                  onClick={(e) => {
                    e.preventDefault()
                    scrolledFor.current = null
                    navigate(`/pref/${pref.slug}#${encodeURIComponent(g.label)}`, { replace: true })
                  }}
                >
                  {g.label}
                </a>
              ))}
            </nav>

            {!queryActive && openCities.size > 0 && (
              <div className="chip-row">
                <button type="button" className="chip" onClick={collapseAll}>
                  {t('prefPage.collapseAll', { n: openCities.size })}
                </button>
              </div>
            )}

            {visibleGroups.map((g) => (
              <details
                key={g.label}
                id={g.label}
                className="city-section"
                open={isOpen(g.label)}
                onToggle={(e) => handleToggle(g.label, e.currentTarget)}
              >
                <summary>
                  {t('prefPage.cityHeading', { city: g.label, n: g.total })}
                  {(chips.active || queryActive) && g.schools.length !== g.total
                    ? `（${t('prefPage.cityShown', { n: g.schools.length })}）`
                    : ''}
                </summary>
                {/* 市区町村ページへの実リンク（クロール経路・c5 C6）。summary の中に置くと
                    details の開閉と競合するので、本文の先頭へ出す。
                    「その他」（市区町村を解決できなかった受け皿）にはページが無い。 */}
                {g.hasPage && (
                  <p className="city-page-link">
                    <a
                      href={cityPagePath(pref.slug, g.label)}
                      onClick={(e) => {
                        e.preventDefault()
                        navigate(cityPagePath(pref.slug, g.label))
                      }}
                    >
                      {t('prefPage.cityPageLink', { city: g.label })} →
                    </a>
                  </p>
                )}
                <ul className="city-school-list">
                  {g.schools.map((s) => {
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
                  {g.schools.length === 0 && (
                    <li className="mini-hint soft">{t('prefPage.cityAllFiltered')}</li>
                  )}
                </ul>
              </details>
            ))}
          </>
        )}

        <p>
          <a
            href="/schools/"
            onClick={(e) => {
              e.preventDefault()
              navigate('/schools')
            }}
          >
            {t('prefPage.backToAll')}
          </a>
        </p>
        <SiteFooter />
      </main>
    </div>
  )
}
