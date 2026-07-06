import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { School } from '../types/school'
import { displayCode, devLabel, OWN_FULL, GEN_FULL, shortSchoolName } from '../lib/format'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'
import { FamilyShareSheet } from '../components/FamilyShareSheet'
import { AdSlot } from '../components/AdSlot'
import { slotsForPlacement } from '../data/ad-slots'
import { countMyData, downloadMyData } from '../lib/export'
import { useApp } from '../contexts/AppContext'

interface Props {
  userData: ReturnType<typeof useUserData>
}

export function FavoritesPage({ userData }: Props) {
  const navigate = useNavigate()
  const { schools } = useSchools()
  const { toast } = useApp()
  const { favorites, notes, mine } = userData
  const [detail, setDetail] = useState<School | null>(null)
  const [familyOpen, setFamilyOpen] = useState(false)

  const dataCount = useMemo(() => countMyData({ favorites, notes, mine }), [favorites, notes, mine])

  const handleExport = () => {
    try {
      downloadMyData(schools, { favorites, notes, mine })
      toast('マイデータをダウンロードしました')
    } catch {
      toast('ダウンロードに失敗しました')
    }
  }

  const favList = useMemo(() => {
    return schools
      .filter((s) => favorites[s.id])
      .sort((a, b) => (favorites[b.id]?.priority ?? 0) - (favorites[a.id]?.priority ?? 0))
  }, [schools, favorites])

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate('/map')} aria-label="地図に戻る">
          ←
        </button>
        <div className="brand">お気に入り高校</div>
        <button className="icon-btn" onClick={() => navigate('/')} aria-label="トップへ">
          🏠
        </button>
      </div>
      <div className="content favs-content">
        <div className="favs-toolbar">
          <span className="sort">並び替え: 志望度順</span>
          <span style={{ display: 'flex', gap: 10 }}>
            {favList.length >= 2 && (
              <button className="compare-link" onClick={() => navigate('/compare')}>
                ⚖ 学校をくらべる
              </button>
            )}
            <button className="compare-link" onClick={() => setFamilyOpen(true)}>
              👨‍👩‍👧 家族で共有
            </button>
          </span>
        </div>

        {favList.length === 0 && (
          <div className="favs-empty">
            まだ志望校が登録されていません
            <br />
            <small>地図画面のピンから ★ で追加できます</small>
          </div>
        )}

        {favList.map((s, i) => {
          const pri = favorites[s.id]?.priority ?? 0
          const stars = '★'.repeat(pri) + '☆'.repeat(Math.max(0, 5 - pri))
          const memo = (notes[s.id]?.note ?? '').split('\n')[0] || '（メモ未入力）'
          return (
            <button className="fav-card" key={s.id} onClick={() => setDetail(s)}>
              <span className="rank">{i + 1}位</span>
              <span className="stars-inline">{stars}</span>
              <h3>
                {shortSchoolName(s.name)}（{displayCode(s)}：{devLabel(s)}）
              </h3>
              <div className="meta">
                {OWN_FULL[s.ownership]} / {GEN_FULL[s.gender_type]} /{' '}
                {s.departments.map((d) => d.name).join('・') || '学科情報なし'}
              </div>
              <div className="memo">{memo}</div>
              <div className="footer">
                <span>{s.address}</span>
                <span>詳細 ›</span>
              </div>
            </button>
          )
        })}

        {favList.length >= 3 &&
          slotsForPlacement('favorites').map((s) => (
            <AdSlot key={s.id} slot={s} categoryLabel="志望校対策" />
          ))}

        <button className="cta secondary" onClick={() => navigate('/map')}>
          ＋ もう一つの候補を追加
        </button>

        <div className="mydata-export">
          <button className="cta secondary" onClick={handleExport} disabled={dataCount === 0}>
            ⬇ マイデータをダウンロード（JSON）
          </button>
          <p className="mydata-note">
            {dataCount === 0
              ? 'お気に入り・メモ・私の記録がまだ無いため、ダウンロードできるデータがありません'
              : `お気に入り・メモ・私の記録（${dataCount} 校分）を 1 つの JSON ファイルに保存できます。機種変更や控えに`}
          </p>
        </div>
      </div>

      {detail && <SchoolDetailSheet school={detail} onClose={() => setDetail(null)} userData={userData} />}
      <FamilyShareSheet open={familyOpen} onClose={() => setFamilyOpen(false)} />
    </div>
  )
}
