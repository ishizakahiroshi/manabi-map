import { useEffect, useRef, useState, type TouchEvent } from 'react'
import type { School } from '../types/school'
import {
  haversine,
  estimateWalkMinutes,
  estimateBikeMinutes,
  estimateCarMinutes,
  estimateTransitMinutes,
  googleMapsRoute,
} from '../lib/geo'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useFormat } from '../hooks/useFormat'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeKey } from '../hooks/useEscapeKey'
import type { useUserData } from '../hooks/useUserData'
import { trackEvent } from '../lib/analytics'
import { supabase } from '../lib/supabase'
import { MAINTENANCE_MODE } from '../lib/maintenance'
import { AdSlot } from './AdSlot'
import { slotsForPlacement } from '../data/ad-slots'

interface Props {
  school: School | null
  onClose: () => void
  userData: ReturnType<typeof useUserData>
}

export function SchoolDetailSheet({ school, onClose, userData }: Props) {
  const { home, toast, setLoginOpen } = useApp()
  const { session } = useAuth()
  const { t } = useI18n()
  const fmt = useFormat()
  const sheetRef = useRef<HTMLDivElement>(null)
  const touchStartY = useRef<number | null>(null)
  const touchCurrentY = useRef<number | null>(null)
  const { favorites, notes, mine, toggleFavorite, setPriority, saveNote, saveMineValue, saveMineNote, saveMineConsent } = userData

  const [memo, setMemo] = useState('')
  const [commuteNote, setCommuteNote] = useState('')
  const [mineNote, setMineNote] = useState('')
  const [mineDeptDraft, setMineDeptDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminDraft, setAdminDraft] = useState<Record<string, string>>({})
  const [adminOverride, setAdminOverride] = useState<Record<string, number>>({})
  const [adminReason, setAdminReason] = useState('')
  const [adminPin, setAdminPin] = useState('')
  const [adminSavingDept, setAdminSavingDept] = useState<string | null>(null)
  const [adminRebuilding, setAdminRebuilding] = useState(false)
  const [reviewRows, setReviewRows] = useState<
    Array<{
      department_id: string
      department_name: string
      official_value: number | null
      submission_count: number
      avg_value: number
      median_value: number
      min_value: number
      max_value: number
    }>
  >([])

  const schoolId = school?.id ?? null
  const open = school != null

  useFocusTrap(sheetRef, open)
  useEscapeKey(onClose, open)

  useEffect(() => {
    if (!schoolId) return
    // 詳細シート開封（school 切替時に 1 回）。PII は載せない（school_id / prefecture のみ）
    trackEvent('detail_open', { school_id: schoolId, prefecture: school?.prefecture })
    const n = notes[schoolId]
    setMemo(n?.note ?? '')
    setCommuteNote(n?.commute_note ?? '')
    setMineNote(mine[schoolId]?.note ?? '')
    // 学科別ドラフトは mineRec から string へ再同期（school 切替時のみ）
    const src = mine[schoolId]?.depts ?? {}
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(src)) next[k] = v == null ? '' : String(v)
    setMineDeptDraft(next)
    const adminNext: Record<string, string> = {}
    for (const d of school?.departments ?? []) adminNext[d.id] = d.deviation == null ? '' : String(d.deviation)
    setAdminDraft(adminNext)
    setAdminOverride({})
    setAdminReason('')
    setAdminPin('')
    // school 切替時のみ同期（notes/mine の参照更新でユーザー入力を上書きしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId])

  useEffect(() => {
    if (!session) {
      setIsAdmin(false)
      return
    }
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.rpc('is_admin')
      if (!cancelled) setIsAdmin(!error && data === true)
    })()
    return () => {
      cancelled = true
    }
  }, [session])

  useEffect(() => {
    if (!isAdmin || !schoolId) {
      setReviewRows([])
      return
    }
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.rpc('get_deviation_review_queue', {
        p_school_id: schoolId,
        p_threshold: 5,
      })
      if (!cancelled) setReviewRows(error ? [] : (data ?? []))
    })()
    return () => {
      cancelled = true
    }
  }, [isAdmin, schoolId])

  if (!school) return null

  const fav = favorites[school.id]
  const mineRec = mine[school.id]
  const dist = home ? haversine(home, { lat: school.latitude, lng: school.longitude }) : null
  const routeUrl = home ? googleMapsRoute(home, school) : null
  const genderRatio = fmt.genderRatioLabel(school)
  // DB 由来 URL は http(s) のみ許可（javascript: 等のスキームを href に通さない多層防御）
  const officialUrl =
    school.official_url && /^https?:\/\//i.test(school.official_url) ? school.official_url : null

  const requireLogin = (): boolean => {
    if (session) return false
    setLoginOpen(true)
    return true
  }

  const handleFav = async () => {
    if (requireLogin()) return
    try {
      const added = await toggleFavorite(school.id)
      toast(added ? t('detail.favAdded') : t('detail.favRemoved'))
    } catch {
      toast(t('detail.saveFail'))
    }
  }

  const handlePri = async (n: number) => {
    if (requireLogin()) return
    try {
      await setPriority(school.id, n)
    } catch {
      toast(t('detail.saveFail'))
    }
  }

  const handleSave = async () => {
    if (requireLogin()) return
    setSaving(true)
    try {
      await saveNote(school.id, memo, commuteNote)
      if (mineNote !== (mineRec?.note ?? '')) await saveMineNote(school.id, mineNote)
      toast(t('detail.saveDone'))
    } catch {
      toast(t('detail.saveFail'))
    } finally {
      setSaving(false)
    }
  }

  const handleMineValue = async (departmentId: string, raw: string) => {
    if (requireLogin()) return
    const v = raw === '' ? null : parseInt(raw, 10)
    if (v != null && (Number.isNaN(v) || v < 20 || v > 80)) return
    // 既存値と同じなら DB 書込しない（無駄書込防止）
    const current = mineRec?.depts[departmentId] ?? null
    if (v === current) return
    try {
      await saveMineValue(school.id, departmentId, v)
    } catch {
      toast(t('detail.saveFailShort'))
    }
  }

  const handleMineBlur = (departmentId: string) => {
    const raw = mineDeptDraft[departmentId] ?? ''
    void handleMineValue(departmentId, raw)
  }

  const handleMineClear = (departmentId: string) => {
    setMineDeptDraft((prev) => ({ ...prev, [departmentId]: '' }))
    void handleMineValue(departmentId, '')
  }

  const handleConsent = async (checked: boolean) => {
    if (requireLogin()) return
    try {
      await saveMineConsent(school.id, checked)
      if (checked) toast(t('detail.consentDone'))
    } catch {
      toast(t('detail.saveFailShort'))
    }
  }

  const displayedDeviation = (departmentId: string, original: number | null): number | null =>
    adminOverride[departmentId] ?? original

  const handleAdminCorrection = async (departmentId: string) => {
    if (requireLogin()) return
    if (MAINTENANCE_MODE) {
      toast(t('maintenance.toast'))
      return
    }
    const raw = adminDraft[departmentId] ?? ''
    const nextValue = parseInt(raw, 10)
    if (Number.isNaN(nextValue) || nextValue < 20 || nextValue > 80) {
      toast(t('detail.adminValueInvalid'))
      return
    }
    if (adminReason.trim().length < 4) {
      toast(t('detail.adminReasonRequired'))
      return
    }
    if (!adminPin) {
      toast(t('detail.adminPinRequired'))
      return
    }
    setAdminSavingDept(departmentId)
    try {
      const { error } = await supabase.rpc('correct_school_deviation', {
        p_department_id: departmentId,
        p_new_value: nextValue,
        p_reason: adminReason,
        p_pin: adminPin,
      })
      if (error) throw error
      setAdminOverride((cur) => ({ ...cur, [departmentId]: nextValue }))
      setAdminPin('')
      toast(t('detail.adminCorrectionDone'))
    } catch {
      toast(t('detail.adminCorrectionFail'))
    } finally {
      setAdminSavingDept(null)
    }
  }

  const handleSnapshotRebuild = async () => {
    if (requireLogin()) return
    if (MAINTENANCE_MODE) {
      toast(t('maintenance.toast'))
      return
    }
    setAdminRebuilding(true)
    try {
      const { error } = await supabase.functions.invoke('trigger-snapshot-rebuild', { body: {} })
      if (error) throw error
      toast(t('detail.adminRebuildDone'))
    } catch {
      toast(t('detail.adminRebuildFail'))
    } finally {
      setAdminRebuilding(false)
    }
  }

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY ?? null
    touchStartY.current = y
    touchCurrentY.current = y
  }

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    touchCurrentY.current = event.touches[0]?.clientY ?? touchCurrentY.current
  }

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const startY = touchStartY.current
    const currentY = touchCurrentY.current
    touchStartY.current = null
    touchCurrentY.current = null
    if (startY == null) return
    const endY = event.changedTouches[0]?.clientY ?? currentY ?? startY
    if (endY - startY > 60) onClose()
  }

  return (
    <div
      ref={sheetRef}
      className="sheet full"
      role="dialog"
      aria-modal="true"
      aria-label={school.name}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <button className="handle" onClick={onClose} aria-label={t('common.close')} />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title">{fmt.displayName(school)}</h3>
        </span>
      </div>
      <div className="body">
        <p className="detail-meta">
          {[fmt.ownFull(school), fmt.genFull(school.gender_type), fmt.typeFull(school.type)].join(' / ')}
        </p>

        <div className="info-grid">
          {school.address && (
            <div className="wide">
              <span>{t('detail.address')}</span>
              <b>
                {school.postal_code ? `〒${school.postal_code}　` : ''}
                {school.address}
              </b>
            </div>
          )}
          <div>
            <span>{t('detail.course')}</span>
            <b>{fmt.courseTimeLabel(school)}</b>
          </div>
          <div>
            <span>{t('detail.scale')}</span>
            <b>{fmt.enrollmentLabel(school)}</b>
          </div>
          {genderRatio && (
            <div>
              <span>{t('detail.genderRatio')}</span>
              <b>{genderRatio}</b>
            </div>
          )}
          {school.campus_type !== 'main' && (
            <div>
              <span>{t('detail.campus')}</span>
              <b>
                {fmt.campusFull(school.campus_type) || t('common.infoPending')}
                {school.main_school_name ? ` / ${t('labels.mainSchool', { name: school.main_school_name })}` : ''}
              </b>
            </div>
          )}
        </div>

        <div className="detail-actions">
          <span className="pri-label">{t('detail.priority')}</span>
          <div className="stars" role="radiogroup" aria-label={t('detail.priority')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={(fav?.priority ?? 0) >= n ? 'on' : ''}
                onClick={() => void handlePri(n)}
                aria-label={t('detail.priorityN', { n })}
              >
                ★
              </button>
            ))}
          </div>
        </div>

        <div className="ext-links">
          {officialUrl ? (
            <a href={officialUrl} target="_blank" rel="noreferrer">
              🌐 {t('detail.official')}
            </a>
          ) : (
            <a href="#none" onClick={(e) => { e.preventDefault(); toast(t('detail.officialSoon')) }}>
              🌐 {t('detail.official')}
            </a>
          )}
          {routeUrl && (
            <a href={routeUrl} target="_blank" rel="noreferrer">
              🗺 {t('detail.googleMaps')}
            </a>
          )}
        </div>

        <div className="depts">
          <h4>🎓 {t('detail.deptDeviation')}</h4>
          <div>
            {school.departments.map((d) => {
              const mv = mineRec?.depts[d.id]
              const dev = displayedDeviation(d.id, d.deviation)
              return (
                <div className="dep-row" key={d.id}>
                  <span className="dep-name">{d.name}</span>
                  <span className="dep-dev">
                    {dev != null ? (
                      <>
                        {t('detail.refValue')} <b>{dev}</b>
                      </>
                    ) : (
                      <>{t('common.infoPending')}</>
                    )}
                    {mv != null && (
                      <span className="mine-val">
                        / {t('detail.myRecord')} <b>{mv}</b>
                        <span className="self-label">{t('detail.mineSelfLabel')}</span>
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="note">
            {t('detail.sourceNote')}
            <br />
            {t('detail.disclaimer')}
            <br />
            <a
              href="https://github.com/ishizakahiroshi/manabi-map/issues/new?labels=data-correction"
              target="_blank"
              rel="noreferrer"
            >
              {t('detail.correction')}
            </a>
          </p>
        </div>

        <div className="mine-block">
          <h4>📊 {t('detail.myBlockTitle')}</h4>
          <p className="sub">
            {t('detail.myBlockSub')}
            <br />
            {t('detail.myBlockSub2')}
          </p>
          <div>
            {school.departments.map((d) => (
              <div className="mine-row" key={d.id}>
                <span className="n">{d.name}</span>
                <span className="ref">
                  {t('detail.refValue')} {displayedDeviation(d.id, d.deviation) ?? t('common.dash')}
                </span>
                <input
                  className="val"
                  type="number"
                  min={20}
                  max={80}
                  placeholder={t('common.dash')}
                  value={mineDeptDraft[d.id] ?? ''}
                  onChange={(e) => setMineDeptDraft((prev) => ({ ...prev, [d.id]: e.target.value }))}
                  onBlur={() => handleMineBlur(d.id)}
                  aria-label={t('detail.myRecordAria', { name: d.name })}
                />
                {mineRec?.depts[d.id] != null && (
                  <button className="clr" title={t('common.clear')} onClick={() => handleMineClear(d.id)}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <textarea
            className="mine-note"
            placeholder={t('detail.myNotePlaceholder')}
            value={mineNote}
            onChange={(e) => setMineNote(e.target.value)}
            aria-label={t('detail.myNoteAria')}
          />
          <label className="mine-consent">
            <input
              type="checkbox"
              checked={mineRec?.visibility === 'submit_to_manabi'}
              onChange={(e) => void handleConsent(e.target.checked)}
            />
            <span>{t('detail.consent')}</span>
          </label>
        </div>

        {isAdmin && (
          <div className="admin-block">
            <h4>{t('detail.adminTitle')}</h4>
            <p className="sub">{t('detail.adminSub')}</p>
            <label>
              {t('detail.adminReason')}
              <textarea
                value={adminReason}
                onChange={(e) => setAdminReason(e.target.value)}
                placeholder={t('detail.adminReasonPlaceholder')}
              />
            </label>
            <label>
              {t('detail.adminPin')}
              <input
                type="password"
                inputMode="numeric"
                value={adminPin}
                onChange={(e) => setAdminPin(e.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="admin-dept-list">
              {school.departments.map((d) => (
                <div className="admin-dept-row" key={d.id}>
                  <span>
                    <b>{d.name}</b>
                    <small>
                      {t('detail.refValue')} {displayedDeviation(d.id, d.deviation) ?? t('common.dash')}
                    </small>
                  </span>
                  <input
                    type="number"
                    min={20}
                    max={80}
                    value={adminDraft[d.id] ?? ''}
                    onChange={(e) => setAdminDraft((cur) => ({ ...cur, [d.id]: e.target.value }))}
                    aria-label={t('detail.adminValueAria', { name: d.name })}
                  />
                  <button
                    type="button"
                    onClick={() => void handleAdminCorrection(d.id)}
                    disabled={adminSavingDept === d.id}
                  >
                    {adminSavingDept === d.id ? t('common.saving') : t('detail.adminApply')}
                  </button>
                </div>
              ))}
            </div>
            <div className="admin-review">
              <h5>{t('detail.adminReviewTitle')}</h5>
              {reviewRows.length > 0 ? (
                reviewRows.map((r) => (
                  <div className="admin-review-row" key={r.department_id}>
                    <span>{r.department_name}</span>
                    <b>{t('detail.adminReviewStats', {
                      count: r.submission_count,
                      avg: r.avg_value,
                      median: r.median_value,
                      min: r.min_value,
                      max: r.max_value,
                    })}</b>
                  </div>
                ))
              ) : (
                <p className="sub">{t('detail.adminReviewEmpty')}</p>
              )}
            </div>
            <button
              type="button"
              className="admin-rebuild"
              onClick={() => void handleSnapshotRebuild()}
              disabled={adminRebuilding}
            >
              {adminRebuilding ? t('detail.adminRebuildRunning') : t('detail.adminRebuild')}
            </button>
          </div>
        )}

        {home && dist != null && (
          <div className="commute">
            <h4>🏠 {t('detail.commute')}</h4>
            <div className="row">
              <span>{t('detail.straightDist')}</span>
              <b>{dist.toFixed(1)} km</b>
            </div>
            <div className="row">
              <span>{t('detail.commuteEst')}</span>
              <b>
                {t('detail.commuteEstVal', {
                  walk: estimateWalkMinutes(dist),
                  bike: estimateBikeMinutes(dist),
                  car: estimateCarMinutes(dist),
                  transit: estimateTransitMinutes(dist),
                })}
                <span className="todo"> {t('common.estimate')}</span>
              </b>
            </div>
            {routeUrl && (
              <a className="btn" href={routeUrl} target="_blank" rel="noreferrer">
                {t('detail.route')}
              </a>
            )}
            <label htmlFor="commute-note">{t('detail.commuteNote')}</label>
            <textarea
              id="commute-note"
              placeholder={t('detail.commutePlaceholder')}
              value={commuteNote}
              onChange={(e) => setCommuteNote(e.target.value)}
            />
          </div>
        )}

        <div className="memo-section">
          <h4>📝 {t('detail.memo')}</h4>
          <textarea
            placeholder={t('detail.memoPlaceholder')}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            aria-label={t('detail.memoAria')}
          />
        </div>

        <button className="save-btn" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>

        {slotsForPlacement('school-detail', school.prefecture).map((s) => (
          <AdSlot
            key={s.id}
            slot={s}
            categoryLabel={t('detail.adCategory')}
            context={{ schoolId: school.id, prefecture: school.prefecture }}
          />
        ))}
      </div>
      <div className="sheet-bottom-bar" role="navigation" aria-label={t('detail.bottomBar')}>
        <button className={`fav-toggle ${fav ? 'on' : ''}`} onClick={() => void handleFav()}>
          <span className="s">★</span> {fav ? t('detail.favorited') : t('detail.interested')}
        </button>
        <button className="sheet-close-bar" onClick={onClose} aria-label={t('detail.closeBar')}>
          ▼ {t('common.close')}
        </button>
      </div>
    </div>
  )
}
