import { useEffect, useState } from 'react'
import type { School } from '../types/school'
import { displayName, OWN_FULL, GEN_FULL, TYPE_FULL } from '../lib/format'
import { haversine, estimateCommuteMinutes, googleMapsRoute } from '../lib/geo'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import type { useUserData } from '../hooks/useUserData'
import { AdSlot } from './AdSlot'

interface Props {
  school: School | null
  onClose: () => void
  userData: ReturnType<typeof useUserData>
}

/** 学校所在地から市郡名を取り出す（塾アフィリ枠の地域見出し用） */
function regionOf(school: School): string {
  const m = school.address.split('県')[1]?.split(/[市郡]/)[0]
  return m ? `${m}${school.address.includes(`${m}郡`) ? '郡' : '市'}` : '地域'
}

export function SchoolDetailSheet({ school, onClose, userData }: Props) {
  const { home, toast, setLoginOpen } = useApp()
  const { session } = useAuth()
  const { favorites, notes, mine, toggleFavorite, setPriority, saveNote, saveMineValue, saveMineNote, saveMineConsent } = userData

  const [memo, setMemo] = useState('')
  const [commuteNote, setCommuteNote] = useState('')
  const [mineNote, setMineNote] = useState('')
  const [saving, setSaving] = useState(false)

  const schoolId = school?.id ?? null

  useEffect(() => {
    if (!schoolId) return
    const n = notes[schoolId]
    setMemo(n?.note ?? '')
    setCommuteNote(n?.commute_note ?? '')
    setMineNote(mine[schoolId]?.note ?? '')
    // school 切替時のみ同期（notes/mine の参照更新でユーザー入力を上書きしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId])

  if (!school) return null

  const fav = favorites[school.id]
  const mineRec = mine[school.id]
  const dist = home ? haversine(home, { lat: school.latitude, lng: school.longitude }) : null
  const routeUrl = home ? googleMapsRoute(home, school) : null

  const requireLogin = (): boolean => {
    if (session) return false
    setLoginOpen(true)
    return true
  }

  const handleFav = async () => {
    if (requireLogin()) return
    try {
      const added = await toggleFavorite(school.id)
      toast(added ? '志望校に追加しました' : 'お気に入りから外しました')
    } catch {
      toast('保存に失敗しました。通信環境を確認してください')
    }
  }

  const handlePri = async (n: number) => {
    if (requireLogin()) return
    try {
      await setPriority(school.id, n)
    } catch {
      toast('保存に失敗しました。通信環境を確認してください')
    }
  }

  const handleSave = async () => {
    if (requireLogin()) return
    setSaving(true)
    try {
      await saveNote(school.id, memo, commuteNote)
      if (mineNote !== (mineRec?.note ?? '')) await saveMineNote(school.id, mineNote)
      toast('保存しました')
    } catch {
      toast('保存に失敗しました。通信環境を確認してください')
    } finally {
      setSaving(false)
    }
  }

  const handleMineValue = async (departmentId: string, raw: string) => {
    if (requireLogin()) return
    const v = raw === '' ? null : parseInt(raw, 10)
    if (v != null && (Number.isNaN(v) || v < 20 || v > 80)) return
    try {
      await saveMineValue(school.id, departmentId, v)
    } catch {
      toast('保存に失敗しました')
    }
  }

  const handleConsent = async (checked: boolean) => {
    if (requireLogin()) return
    try {
      await saveMineConsent(school.id, checked)
      if (checked) toast('統計提供に同意しました')
    } catch {
      toast('保存に失敗しました')
    }
  }

  return (
    <div className="sheet full" aria-modal="true" role="dialog" aria-label={school.name}>
      <button className="handle" onClick={onClose} aria-label="閉じる" />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title">{displayName(school)}</h3>
        </span>
        <button className="sheet-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>
      <div className="body">
        <p className="detail-meta">
          {[OWN_FULL[school.ownership], GEN_FULL[school.gender_type], TYPE_FULL[school.type]].join(' / ')} —{' '}
          {school.address}
        </p>

        <div className="detail-actions">
          <button className={`fav-toggle ${fav ? 'on' : ''}`} onClick={() => void handleFav()}>
            <span className="s">★</span> {fav ? '志望校です' : '気になる'}
          </button>
          <span className="pri-label">志望度</span>
          <div className="stars" role="radiogroup" aria-label="志望度">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={(fav?.priority ?? 0) >= n ? 'on' : ''}
                onClick={() => void handlePri(n)}
                aria-label={`志望度 ${n}`}
              >
                ★
              </button>
            ))}
          </div>
        </div>

        <div className="ext-links">
          {school.official_url ? (
            <a href={school.official_url} target="_blank" rel="noreferrer">
              🌐 公式サイト
            </a>
          ) : (
            <a href="#none" onClick={(e) => { e.preventDefault(); toast('公式サイト情報は準備中です') }}>
              🌐 公式サイト
            </a>
          )}
          {routeUrl && (
            <a href={routeUrl} target="_blank" rel="noreferrer">
              🗺 Google Maps
            </a>
          )}
        </div>

        <div className="depts">
          <h4>🎓 学科別 参考偏差値</h4>
          <div>
            {school.departments.map((d) => {
              const mv = mineRec?.depts[d.id]
              return (
                <div className="dep-row" key={d.id}>
                  <span className="dep-name">{d.name}</span>
                  <span className="dep-dev">
                    {d.deviation != null ? (
                      <>
                        参考値 <b>{d.deviation}</b>
                      </>
                    ) : (
                      <>情報募集中</>
                    )}
                    {mv != null && (
                      <span className="mine-val">
                        / 私の記録 <b>{mv}</b>
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="note">
            出典: <b>Manabi Map 独自推計</b>（公的資料に基づく）
            <br />
            ※ あくまで目安です。正確な情報は学校公式・県教委資料で確認してください。
            <br />
            <a
              href="https://github.com/ishizakahiroshi/manabi-map/issues/new?labels=data-correction"
              target="_blank"
              rel="noreferrer"
            >
              この値についての情報提供・訂正要請 →
            </a>
          </p>
        </div>

        <div className="mine-block">
          <h4>📊 私の記録（あなただけに見える）</h4>
          <p className="sub">
            塾で聞いた値・模試の判定など、家庭の情報をここに残せます。
            <br />
            Manabi Map の参考値とは別に本人だけに表示されます。
          </p>
          <div>
            {school.departments.map((d) => (
              <div className="mine-row" key={d.id}>
                <span className="n">{d.name}</span>
                <span className="ref">参考値 {d.deviation ?? '−'}</span>
                <input
                  className="val"
                  type="number"
                  min={20}
                  max={80}
                  placeholder="—"
                  value={mineRec?.depts[d.id] ?? ''}
                  onChange={(e) => void handleMineValue(d.id, e.target.value)}
                  aria-label={`${d.name} の私の記録`}
                />
                {mineRec?.depts[d.id] != null && (
                  <button className="clr" title="クリア" onClick={() => void handleMineValue(d.id, '')}>
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <textarea
            className="mine-note"
            placeholder="例: 塾で55と聞いた / 模試A判定 55-58"
            value={mineNote}
            onChange={(e) => setMineNote(e.target.value)}
            aria-label="私の記録メモ"
          />
          <label className="mine-consent">
            <input
              type="checkbox"
              checked={mineRec?.visibility === 'submit_to_manabi'}
              onChange={(e) => void handleConsent(e.target.checked)}
            />
            <span>
              この値を <b>Manabi Map 参考値の改善</b>に匿名で提供する（統計集計のみ・個別データは公開されません）
            </span>
          </label>
        </div>

        {home && dist != null && (
          <div className="commute">
            <h4>🏠 通学（自宅から）</h4>
            <div className="row">
              <span>直線距離</span>
              <b>{dist.toFixed(1)} km</b>
            </div>
            <div className="row">
              <span>概算通学時間</span>
              <b>
                車 約{estimateCommuteMinutes(dist)}分 <span className="todo">推定</span>
              </b>
            </div>
            {routeUrl && (
              <a className="btn" href={routeUrl} target="_blank" rel="noreferrer">
                自宅→この学校 経路を見る
              </a>
            )}
            <label htmlFor="commute-note">通学メモ</label>
            <textarea
              id="commute-note"
              placeholder="例: 冬の吾妻線が心配 / 部活後の帰りは 19 時"
              value={commuteNote}
              onChange={(e) => setCommuteNote(e.target.value)}
            />
          </div>
        )}

        <div className="memo-section">
          <h4>📝 メモ</h4>
          <textarea
            placeholder="文化祭に行ってみたい / 吹奏楽部を調べる"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            aria-label="学校メモ"
          />
        </div>

        <button className="save-btn" onClick={() => void handleSave()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>

        <AdSlot
          category="この学校の近くの塾"
          title={`${regionOf(school)} の学習塾を探す`}
          description="学校の所在地に基づく塾情報（志望校対策）"
          cta="塾を探す"
        />
      </div>
    </div>
  )
}
