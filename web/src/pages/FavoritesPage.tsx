import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { School } from '../types/school'
import { shortSchoolName } from '../lib/format'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'
import { FamilyShareSheet } from '../components/FamilyShareSheet'
import { AdSlot } from '../components/AdSlot'
import { slotsForPlacement } from '../data/ad-slots'
import { countMyData, downloadMyData } from '../lib/export'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { useFormat } from '../hooks/useFormat'

interface Props {
  userData: ReturnType<typeof useUserData>
}

export function FavoritesPage({ userData }: Props) {
  const navigate = useNavigate()
  const { schools } = useSchools()
  const { toast } = useApp()
  const { t } = useI18n()
  const fmt = useFormat()
  const { favorites, notes, mine } = userData
  const [detail, setDetail] = useState<School | null>(null)
  const [familyOpen, setFamilyOpen] = useState(false)

  const dataCount = useMemo(() => countMyData({ favorites, notes, mine }), [favorites, notes, mine])

  const handleExport = () => {
    try {
      downloadMyData(schools, { favorites, notes, mine })
      toast(t('favorites.exportDone'))
    } catch {
      toast(t('favorites.exportFail'))
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
        <button className="icon-btn" onClick={() => navigate('/map')} aria-label={t('favorites.backMap')}>
          ←
        </button>
        <div className="brand">{t('nav.favoritesTitle')}</div>
        <button className="icon-btn" onClick={() => navigate('/')} aria-label={t('common.home')}>
          🏠
        </button>
      </div>
      <main id="main-content" className="content favs-content" tabIndex={-1}>
        <div className="favs-toolbar">
          <span className="sort">{t('favorites.sort')}</span>
          <span style={{ display: 'flex', gap: 10 }}>
            {favList.length >= 2 && (
              <button className="compare-link" onClick={() => navigate('/compare')}>
                ⚖ {t('favorites.compare')}
              </button>
            )}
            <button className="compare-link" onClick={() => setFamilyOpen(true)}>
              👨‍👩‍👧 {t('favorites.familyShare')}
            </button>
          </span>
        </div>

        {favList.length === 0 && (
          <div className="favs-empty">
            {t('favorites.empty')}
            <br />
            <small>{t('favorites.emptyHint')}</small>
          </div>
        )}

        {favList.map((s, i) => {
          const pri = favorites[s.id]?.priority ?? 0
          const stars = '★'.repeat(pri) + '☆'.repeat(Math.max(0, 5 - pri))
          const memo = (notes[s.id]?.note ?? '').split('\n')[0] || t('common.noMemo')
          return (
            <button className="fav-card" key={s.id} onClick={() => setDetail(s)}>
              <span className="rank">{t('favorites.rank', { n: i + 1 })}</span>
              <span className="stars-inline" aria-hidden="true">{stars}</span>
              <h3>
                {shortSchoolName(s.name, s)}（{fmt.displayCode(s)}：{fmt.devLabel(s)}）
              </h3>
              <div className="meta">
                {fmt.ownFull(s)} / {fmt.genFull(s.gender_type)} /{' '}
                {s.departments.map((d) => d.name).join('・') || t('favorites.noDept')}
              </div>
              <div className="memo">{memo}</div>
              <div className="footer">
                <span>{s.address}</span>
                <span>{t('favorites.detail')}</span>
              </div>
            </button>
          )
        })}

        {favList.length >= 3 &&
          slotsForPlacement('favorites').map((s) => (
            <AdSlot key={s.id} slot={s} categoryLabel={t('favorites.adCategory')} />
          ))}

        <button className="cta secondary" onClick={() => navigate('/map')}>
          {t('favorites.addMore')}
        </button>

        <div className="mydata-export">
          <button className="cta secondary" onClick={handleExport} disabled={dataCount === 0}>
            ⬇ {t('favorites.export')}
          </button>
          <p className="mydata-note">
            {dataCount === 0 ? t('favorites.exportNoteEmpty') : t('favorites.exportNote', { count: dataCount })}
          </p>
        </div>
      </main>

      {detail && <SchoolDetailSheet school={detail} onClose={() => setDetail(null)} userData={userData} />}
      <FamilyShareSheet open={familyOpen} onClose={() => setFamilyOpen(false)} />
    </div>
  )
}