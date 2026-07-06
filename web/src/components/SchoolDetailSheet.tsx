import { useEffect, useRef, useState } from 'react'
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
  const { favorites, notes, mine, toggleFavorite, setPriority, saveNote, saveMineValue, saveMineNote, saveMineConsent } = userData

  const [memo, setMemo] = useState('')
  const [commuteNote, setCommuteNote] = useState('')
  const [mineNote, setMineNote] = useState('')
  const [mineDeptDraft, setMineDeptDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

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
    // school 切替時のみ同期（notes/mine の参照更新でユーザー入力を上書きしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId])

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

  return (
    <div
      ref={sheetRef}
      className="sheet full"
      role="dialog"
      aria-modal="true"
      aria-label={school.name}
    >
      <button className="handle" onClick={onClose} aria-label={t('common.close')} />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title">{fmt.displayName(school)}</h3>
        </span>
        <button className="sheet-close" onClick={onClose} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="body">
        <p className="detail-meta">
          {[fmt.ownFull(school), fmt.genFull(school.gender_type), fmt.typeFull(school.type)].join(' / ')} —{' '}
          {school.address}
        </p>

        <div className="info-grid">
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
          <button className={`fav-toggle ${fav ? 'on' : ''}`} onClick={() => void handleFav()}>
            <span className="s">★</span> {fav ? t('detail.favorited') : t('detail.interested')}
          </button>
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
              return (
                <div className="dep-row" key={d.id}>
                  <span className="dep-name">{d.name}</span>
                  <span className="dep-dev">
                    {d.deviation != null ? (
                      <>
                        {t('detail.refValue')} <b>{d.deviation}</b>
                      </>
                    ) : (
                      <>{t('common.infoPending')}</>
                    )}
                    {mv != null && (
                      <span className="mine-val">
                        / {t('detail.myRecord')} <b>{mv}</b>
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
                  {t('detail.refValue')} {d.deviation ?? t('common.dash')}
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
    </div>
  )
}