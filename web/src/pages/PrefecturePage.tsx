import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { loadSearchIndexes, normalizeForMatch } from '../lib/searchIndex'
import { prefectureBySlug } from '../lib/prefecture'
import { ownershipFull, devLabel, topDev, GEN_FULL, COURSE_TIME_FULL } from '../lib/format'
import { primaryAdmissionTrend } from '../lib/admission'
import { trackEvent } from '../lib/analytics'
import type { CourseTime, GenderType, School } from '../types/school'
import { SiteFooter } from '../components/SiteFooter'
import { NotFoundPage } from './NotFoundPage'

/** 解決不能校の受け皿（scripts/lib/municipalities.mjs の UNRESOLVED_CITY_LABEL と同値）。 */
const UNRESOLVED_CITY = 'その他'

type OwnershipChip = 'public' | 'private' | 'national'

interface ChipState {
  ownership: Set<OwnershipChip>
  course: Set<CourseTime>
  gender: Set<GenderType>
}

function emptyChips(): ChipState {
  return { ownership: new Set(), course: new Set(), gender: new Set() }
}

function ownershipChipOf(s: School): OwnershipChip {
  if (s.ownership === 'private') return 'private'
  if (s.ownership === 'national') return 'national'
  return 'public'
}

// SchoolDetailSheet と同じ趣旨の状態ラベル（閉校予定・募集停止を一覧でも隠さない）。
const LIFECYCLE_LABELS: Record<string, string> = {
  planned: '開校予定', closing: '在校生のみ', closed: '閉校',
}
const RECRUITMENT_LABELS: Record<string, string> = {
  unknown: '未確認', not_started: '募集開始前',
  no_external_high_school_intake: '高校段階の外部募集なし', stopped: '募集終了',
}

function statusLabel(s: School): string | null {
  const labels = [
    s.lifecycle_status_code !== 'active' ? LIFECYCLE_LABELS[s.lifecycle_status_code] : null,
    s.recruitment_status_code !== 'recruiting' ? RECRUITMENT_LABELS[s.recruitment_status_code] : null,
  ].filter((v): v is string => Boolean(v))
  return labels.length ? labels.join('・') : null
}

interface Props {
  userData: ReturnType<typeof useUserData>
}

/**
 * /pref/:pref — 都道府県ハブ（一覧）。
 * 初回直リンクはプリレンダー HTML（scripts/gen-seo-pages.mjs の renderPrefPage）が出るため、
 * ここは SPA 内遷移と mount 後の描画を担当する（白紙防止）。
 * 並び順は市区町村コード順 → 同一市区町村内は五十音順に固定する。
 * 偏差値順・倍率順のソートは実装しない（ランキングサイト化の禁止線・
 * docs/local/plan_seo-growth-strategy.md §やらないこと）。
 */
export function PrefecturePage({ userData }: Props) {
  const { pref: slug } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { setHome } = useApp()
  const { t } = useI18n()
  const { schools, loading, error } = useSchools()
  const { favorites } = userData
  const pref = slug ? prefectureBySlug(slug) : null

  const [cityOrder, setCityOrder] = useState<string[] | null>(null)
  const [cityBySchool, setCityBySchool] = useState<Map<string, string> | null>(null)
  const [openCities, setOpenCities] = useState<Set<string>>(new Set())
  const [chips, setChips] = useState<ChipState>(emptyChips)
  const [q, setQ] = useState('')
  const scrolledFor = useRef<string | null>(null)
  // 貼り付いた見出しの判定に実測値を使う（CSS の --city-jump-h と二重管理しない）
  const jumpRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!pref) return
    let cancelled = false
    void loadSearchIndexes()
      .then(({ cities, schools: indexed }) => {
        if (cancelled) return
        setCityOrder(cities.filter((c) => c.pref === pref.name).map((c) => c.city))
        setCityBySchool(
          new Map(
            indexed
              .filter((s) => s.pref === pref.name)
              .map((s) => [s.id, s.city ?? UNRESOLVED_CITY]),
          ),
        )
      })
      .catch(() => {
        // 索引が取れなくても一覧自体は出す（市区町村コード順の代わりに名称順へ劣化）
        if (!cancelled) {
          setCityOrder([])
          setCityBySchool(new Map())
        }
      })
    return () => {
      cancelled = true
    }
  }, [pref])

  const prefSchools = useMemo(
    () => (pref ? schools.filter((s) => s.prefecture === pref.name) : []),
    [schools, pref],
  )

  const groups = useMemo(() => {
    if (cityBySchool == null || cityOrder == null) return []
    const byCity = new Map<string, School[]>()
    for (const school of prefSchools) {
      // 索引に無い校（索引取得失敗時の全校を含む）は city 値そのまま → 無ければ「その他」
      const city = cityBySchool.get(school.id) ?? school.city ?? UNRESOLVED_CITY
      const list = byCity.get(city) ?? []
      list.push(school)
      byCity.set(city, list)
    }
    const collator = new Intl.Collator('ja')
    const orderedLabels = [
      ...cityOrder.filter((c) => byCity.has(c)),
      ...[...byCity.keys()].filter((c) => !cityOrder.includes(c)).sort(collator.compare),
    ]
    return orderedLabels.map((label) => {
      const list = (byCity.get(label) ?? []).slice()
      list.sort((a, b) => collator.compare(a.name_kana ?? a.name, b.name_kana ?? b.name))
      return { label, schools: list }
    })
  }, [prefSchools, cityBySchool, cityOrder])

  /**
   * 設置区分・課程の行へ続けて出す補足（地図ピンと同じ値: 参考偏差値と最新年度の一次募集倍率）。
   * 行を増やさず同じメタ行に「 ・ 」で連結する（幅が足りなければ自然に折り返す）。
   * 値のある学校だけを持つ Map なので、未収集の学校には行を足さない（「−」の羅列を作らない）。
   * 数値は地図ピンと同じ devLabel / primaryAdmissionTrend から取り、表示の食い違いを作らない。
   * chip 切替や市区町村の開閉で再計算しないよう memo 化する（MapPage の ratioBands と同じ方針）。
   * これは React 描画側だけの表示で、プリレンダー HTML には出さない
   * （§7.7 表示規約: 偏差値はプリレンダー内容に一切含めない・gen-seo-pages.mjs 冒頭）。
   */
  const factsById = useMemo(() => {
    const facts = new Map<string, string>()
    for (const school of prefSchools) {
      const parts: string[] = []
      if (topDev(school) != null) parts.push(t('prefPage.deviationLabel', { v: devLabel(school) }))
      const latest = primaryAdmissionTrend(school)?.annual[0]
      if (latest) {
        parts.push(
          t('prefPage.admissionLatest', { year: latest.year, ratio: latest.ratio.toFixed(2) }),
        )
      }
      if (parts.length) facts.set(school.id, parts.join(' ・ '))
    }
    return facts
  }, [prefSchools, t])

  /**
   * 校名しぼりこみ用の正規化済み文字列（校名＋ふりがな）。
   * 1 文字入力するたびに 440 校ぶんの正規化を走らせないよう、県の学校集合が変わった時だけ作る。
   * 市区町村名は見出し側（groups の label）で突き合わせるのでここには含めない
   * （school.city は索引由来の表示名と一致しないことがあるため）。
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
      requestAnimationFrame(() => {
        document.getElementById(target)?.scrollIntoView({ block: 'start' })
      })
    }
  }, [location.hash, groups])

  /**
   * ジャンプバーの実高を CSS 変数へ流す。貼り付く見出しの top とアンカー着地の
   * scroll-margin-top がこれを見る（--city-jump-h）。
   * 固定値にできないのは、横スクロールバーを場所取りする環境（Windows のデスクトップ Chrome）で
   * 15px ほど高くなるため。ずれると「見出しがバーに潜って切れる」か
   * 「隙間から一覧が透ける」のどちらかが必ず出る。
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

  if (!pref) return <NotFoundPage />

  const chipActive = chips.ownership.size > 0 || chips.course.size > 0 || chips.gender.size > 0
  const matchesChips = (s: School): boolean => {
    if (chips.ownership.size > 0 && !chips.ownership.has(ownershipChipOf(s))) return false
    if (chips.course.size > 0 && !s.course_times.some((c) => chips.course.has(c))) return false
    if (chips.gender.size > 0 && !chips.gender.has(s.gender_type)) return false
    return true
  }
  const shownCount = prefSchools.filter(matchesChips).length

  // 校名しぼりこみ。見出し（市区町村名）にも当てるので「文京」で文京区の 25 校がまとめて出る。
  const query = normalizeForMatch(q.trim())
  const queryActive = query.length > 0
  const visibleGroups = groups
    .map((g) => {
      const cityHit = queryActive && normalizeForMatch(g.label).includes(query)
      return {
        label: g.label,
        total: g.schools.length,
        schools: g.schools.filter(
          (s) =>
            matchesChips(s) &&
            (!queryActive || cityHit || (haystackById.get(s.id) ?? '').includes(query)),
        ),
      }
    })
    // 検索中は 0 件の市区町村ごと畳む（空の見出しを 58 個スクロールさせない）
    .filter((g) => !queryActive || g.schools.length > 0)
  const queryHits = visibleGroups.reduce((n, g) => n + g.schools.length, 0)
  /** 検索中は一致した市区町村を開いたまま固定する（結果が畳まれて見えなくならないように）。 */
  const isOpen = (label: string) => queryActive || openCities.has(label)

  const count = (fn: (s: School) => boolean) => prefSchools.filter(fn).length
  const chipDefs: Array<{ key: string; label: string; n: number; on: boolean; toggle: () => void }> = []
  const toggleSet = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }
  const ownershipDefs: Array<[OwnershipChip, string]> = [
    ['public', t('prefPage.chipPublic')],
    ['private', t('prefPage.chipPrivate')],
    ['national', t('prefPage.chipNational')],
  ]
  for (const [key, label] of ownershipDefs) {
    const n = count((s) => ownershipChipOf(s) === key)
    if (n === 0) continue
    chipDefs.push({
      key: `own-${key}`, label, n, on: chips.ownership.has(key),
      toggle: () => setChips((c) => ({ ...c, ownership: toggleSet(c.ownership, key) })),
    })
  }
  for (const key of ['fulltime', 'parttime', 'correspondence'] as CourseTime[]) {
    const n = count((s) => s.course_times.includes(key))
    if (n === 0) continue
    chipDefs.push({
      key: `course-${key}`, label: COURSE_TIME_FULL[key], n, on: chips.course.has(key),
      toggle: () => setChips((c) => ({ ...c, course: toggleSet(c.course, key) })),
    })
  }
  for (const key of ['coed', 'girls', 'boys'] as GenderType[]) {
    const n = count((s) => s.gender_type === key)
    if (n === 0) continue
    chipDefs.push({
      key: `gender-${key}`, label: GEN_FULL[key], n, on: chips.gender.has(key),
      toggle: () => setChips((c) => ({ ...c, gender: toggleSet(c.gender, key) })),
    })
  }

  const openSchool = (school: School) => {
    trackEvent('search', { source: 'pref_page' })
    setHome({ label: school.name, lat: school.latitude, lng: school.longitude })
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
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{t('prefPage.title', { pref: pref.name, n: prefSchools.length })}</div>
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

            <div className="chip-row" role="group" aria-label={t('prefPage.chipsLabel')}>
              {chipDefs.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`chip ${c.on ? 'on' : ''}`}
                  aria-pressed={c.on}
                  onClick={c.toggle}
                >
                  {c.label} {c.n}
                </button>
              ))}
            </div>
            {chipActive && (
              <div className="mini-hint" aria-live="polite">
                {t('prefPage.filterShowing', { total: prefSchools.length, shown: shownCount })}{' '}
                <button type="button" className="chip" onClick={() => setChips(emptyChips())}>
                  {t('prefPage.filterClear')}
                </button>
              </div>
            )}

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
                  {(chipActive || queryActive) && g.schools.length !== g.total
                    ? `（${t('prefPage.cityShown', { n: g.schools.length })}）`
                    : ''}
                </summary>
                <ul className="city-school-list">
                  {g.schools.map((s) => {
                    const status = statusLabel(s)
                    const facts = factsById.get(s.id)
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
                        </a>
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
                          {ownershipFull(s)}・{s.course_times.map((c) => COURSE_TIME_FULL[c]).join('・')}
                          {status ? `〔${status}〕` : ''}
                          {facts ? ` ・ ${facts}` : ''}
                        </span>
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
