import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { School } from '../types/school'
import {
  shortSchoolName,
  displayCode,
  devLabel,
  OWN_FULL,
  GEN_FULL,
  COURSE_TIME_FULL,
} from '../lib/format'
import { haversine, estimateBikeMinutes, estimateCarMinutes, estimateTransitMinutes } from '../lib/geo'
import { useApp } from '../contexts/AppContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
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

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate('/favorites')} aria-label="お気に入りに戻る">
          ←
        </button>
        <div className="brand">学校をくらべる</div>
        <button className="icon-btn" onClick={() => navigate('/')} aria-label="トップへ">
          🏠
        </button>
      </div>

      <div className="content compare-content">
        {favList.length < 2 ? (
          <div className="favs-empty">
            くらべるには、お気に入りが 2 校以上必要です
            <br />
            <small>地図画面のピンから ★ で追加できます</small>
            <button className="cta secondary" onClick={() => navigate('/map')}>
              地図で学校をさがす
            </button>
          </div>
        ) : (
          <>
            <div className="compare-picker">
              <div className="cp-label">
                くらべたい学校を選んでください（2〜{MAX_COMPARE} 校） — {selected.length} 校選択中
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
                      {shortSchoolName(s.name)}
                    </button>
                  )
                })}
              </div>
            </div>

            {compareList.length < 2 ? (
              <div className="compare-hint">
                {compareList.length === 0
                  ? '上から 2 校以上えらぶと、ここに比較表が出ます'
                  : 'あと 1 校えらぶと比較できます'}
              </div>
            ) : (
              <>
                <div className="compare-swipe-hint">← 横にスワイプして見くらべ →</div>
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
                          <h3>{shortSchoolName(s.name)}</h3>
                          <div className="cc-sub">
                            {displayCode(s)} ・ {OWN_FULL[s.ownership]} / {GEN_FULL[s.gender_type]} ・{' '}
                            <span className="cc-stars">{'★'.repeat(pri) || '☆'}</span>
                          </div>
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">課程</span>
                          <div className="cc-chips">
                            {s.course_times.length ? (
                              s.course_times.map((c) => (
                                <span className="cc-chip" key={c}>
                                  {COURSE_TIME_FULL[c] ?? c}
                                </span>
                              ))
                            ) : (
                              <span className="cc-soft">情報募集中</span>
                            )}
                          </div>
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">参考偏差値</span>
                          <div>
                            <b className="cc-dev">{devLabel(s)}</b>
                            <small className="cc-soft"> Manabi Map 独自推計・目安</small>
                          </div>
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">自宅から</span>
                          {dist != null ? (
                            <div>
                              直線 <b>{dist.toFixed(1)} km</b>
                              <div className="cc-soft">
                                🚲 約{estimateBikeMinutes(dist)}分 ／ 🚗 約{estimateCarMinutes(dist)}分 ／ 🚃 約
                                {estimateTransitMinutes(dist)}分（推定）
                              </div>
                            </div>
                          ) : (
                            <span className="cc-soft">自宅未設定（トップで住所検索すると出ます）</span>
                          )}
                        </div>

                        <div className="cc-row">
                          <span className="cc-label">メモ</span>
                          {memoLines.length ? (
                            <div className="cc-memo">
                              {memoLines.map((l, i) => (
                                <div key={i}>{l}</div>
                              ))}
                            </div>
                          ) : (
                            <span className="cc-soft">（メモ未入力）</span>
                          )}
                        </div>

                        <button className="cc-detail" onClick={() => setDetail(s)}>
                          くわしく見る ›
                        </button>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {detail && <SchoolDetailSheet school={detail} onClose={() => setDetail(null)} userData={userData} />}
    </div>
  )
}
