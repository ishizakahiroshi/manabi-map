import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { School } from '../types/school'
import { shortSchoolName } from '../lib/format'
import { haversine, estimateBikeMinutes, estimateCarMinutes, estimateTransitMinutes } from '../lib/geo'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { useFormat } from '../hooks/useFormat'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { trackEvent } from '../lib/analytics'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'

interface Props {
  userData: ReturnType<typeof useUserData>
}

const MAX_COMPARE = 4

/**
 * C3: 学校比較表。お気に入り校から 2〜4 校選んで比較する。
 * スマホ縦: 1 画面 1 校カード + 横スワイプ（CSS scroll-snap）
 * PC・タブレット: 2〜4 校の横並び（同一マークアップを media query で切替）
 */
export function ComparePage({ userData }: Props) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { schools } = useSchools()
  const { favorites, notes } = userData
  const { home } = useApp()
  const { t } = useI18n()
  const fmt = useFormat()
  const [detail, setDetail] = useState<School | null>(null)

  const favList = useMemo(() => {
    return schools
      .filter((s) => favorites[s.id])
      .sort((a, b) => (favorites[b.id]?.priority ?? 0) - (favorites[a.id]?.priority ?? 0))
  }, [schools, favorites])

  // 選択状態は URL（?ids=）に持つ。戻る・共有・リロードで選択が消えない
  const selected = useMemo(() => {
    const raw = (params.get('ids') ?? '').split(',').filter(Boolean)
    const favIds = new Set(favList.map((s) => s.id))
    return raw.filter((id) => favIds.has(id)).slice(0, MAX_COMPARE)
  }, [params, favList])

  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : selected.length >= MAX_COMPARE
        ? selected
        : [...selected, id]
    setParams(next.length ? { ids: next.join(',') } : {}, { replace: true })
  }

  const compareList = favList.filter((s) => selected.includes(s.id))

  // 比較表の表示計測。選択構成が変わって 2 校以上そろった時だけ 1 回。校名等の PII は載せない
  const selectionKey = selected.join(',')
  useEffect(() => {
    if (selected.length >= 2) trackEvent('compare_view', { count: selected.length })
    // selectionKey は selected の内容ダイジェスト。選択が変わるたびに再計測する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey])

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate('/favorites')} aria-label={t('compare.backFav')}>
          ←
        </button>
        <div className="brand">{t('compare.title')}</div>
        <button className="icon-btn" onClick={() => navigate('/')} aria-label={t('common.home')}>
          🏠
        </button>
      </div>

      <main id="main-content" className="content compare-content" tabIndex={-1}>
        {favList.length < 2 ? (
          <div className="favs-empty">
            {t('compare.needTwo')}
            <br />
            <small>{t('compare.needTwoHint')}</small>
            <button className="cta secondary" onClick={() => navigate('/map')}>
              {t('compare.findOnMap')}
            </button>
          </div>
        ) : (
          <>
            <div className="compare-picker">
              <div className="cp-label">
                {t('compare.picker', { max: MAX_COMPARE, count: selected.length })}
              </div>
              <div className="cp-chips">
                {favList.map((s) => {
                  const on = selected.includes(s.id)
                  const full = !on && selected.length >= MAX_COMPARE
                  return (
                    <button
                      key={s.id}
                      className={`chip ${on ? 'on' : ''}`}
                      onClick={() => toggle(s.id)}
                      disabled={full}
                      aria-pressed={on}
                    >
                      {on ? '✓ ' : ''}
                      {shortSchoolName(s.name, s)}
                    </button>
                  )
                })}
              </div>
            </div>

            {compareList.length < 2 ? (
              <div className="compare-hint">
                {compareList.length === 0 ? t('compare.hintNone') : t('compare.hintOne')}
              </div>
            ) : (
              <>
                <div className="compare-swipe-hint">{t('compare.swipeHint')}</div>
                <div className="compare-strip" data-count={compareList.length}>
                  {compareList.map((s) => {
                    const pri = favorites[s.id]?.priority ?? 0
                    const dist = home ? haversine(home, { lat: s.latitude, lng: s.longitude }) : null
                    const memoLines = (notes[s.id]?.note ?? '')
                      .split('\n')
                      .map((l) => l.trim())
                      .filter(Boolean)
                      .slice(0, 2)
                    return (
                      <article className="compare-col" key={s.id}>
                        <div className="cc-head">
                          <h3>{shortSchoolName(s.name, s)}</h3>
                          <div className="cc-sub">
                            {fmt.displayCode(s)} ・ {fmt.ownFull(s)} / {fmt.genFull(s.gender_type)} ・{' '}
                            <span className="cc-stars">{'★'.repeat(pri) || '☆'}</span>
                          </div>
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">{t('compare.course')}</span>
                          <div className="cc-chips">
                            {s.course_times.length ? (
                              s.course_times.map((c) => (
                                <span className="cc-chip" key={c}>
                                  {fmt.courseFull(c)}
                                </span>
                              ))
                            ) : (
                              <span className="cc-soft">{t('common.infoPending')}</span>
                            )}
                          </div>
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">{t('compare.deviation')}</span>
                          <div>
                            <b className="cc-dev">{fmt.devLabel(s)}</b>
                            <small className="cc-soft">{t('compare.deviationNote')}</small>
                          </div>
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">{t('compare.fromHome')}</span>
                          {dist != null ? (
                            <div>
                              {t('compare.straight')} <b>{dist.toFixed(1)} km</b>
                              <div className="cc-soft">
                                {t('compare.fromHomeEst', {
                                  bike: estimateBikeMinutes(dist),
                                  car: estimateCarMinutes(dist),
                                  transit: estimateTransitMinutes(dist),
                                })}
                              </div>
                            </div>
                          ) : (
                            <span className="cc-soft">{t('compare.homeUnset')}</span>
                          )}
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">{t('compare.memo')}</span>
                          {memoLines.length ? (
                            <div className="cc-memo">
                              {memoLines.map((l, i) => (
                                <div key={i}>{l}</div>
                              ))}
                            </div>
                          ) : (
                            <span className="cc-soft">{t('common.noMemo')}</span>
                          )}
                        </div>

                        <button className="cc-detail" onClick={() => setDetail(s)}>
                          {t('compare.detail')}
                        </button>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {detail && <SchoolDetailSheet school={detail} onClose={() => setDetail(null)} userData={userData} />}
    </div>
  )
}