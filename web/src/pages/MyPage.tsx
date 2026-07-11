import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { shortSchoolName } from '../lib/format'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useFormat } from '../hooks/useFormat'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { FamilyShareSheet } from '../components/FamilyShareSheet'

interface Props {
  userData: ReturnType<typeof useUserData>
  favCount: number
  noteCount: number
}

export function MyPage({ userData, favCount, noteCount }: Props) {
  const navigate = useNavigate()
  const { schools } = useSchools()
  const { setLoginOpen, toast } = useApp()
  const { session, kind, displayName, signOut } = useAuth()
  const { t } = useI18n()
  const fmt = useFormat()
  const { notes, mine } = userData
  const [familyOpen, setFamilyOpen] = useState(false)

  const noteSchools = useMemo(
    () =>
      schools
        .filter((s) => notes[s.id]?.note || notes[s.id]?.commute_note)
        .sort((a, b) => shortSchoolName(a.name, a).localeCompare(shortSchoolName(b.name, b), 'ja')),
    [schools, notes],
  )

  const mineSchools = useMemo(
    () =>
      schools
        .filter((s) => {
          const record = mine[s.id]
          return !!record && (record.note.trim() !== '' || Object.values(record.depts).some((v) => v != null))
        })
        .sort((a, b) => shortSchoolName(a.name, a).localeCompare(shortSchoolName(b.name, b), 'ja')),
    [schools, mine],
  )

  const needsLogin = !session || kind === 'anon'

  const handleLogin = () => setLoginOpen(true)

  const handleSignOut = async () => {
    try {
      await signOut()
      toast(t('nav.logoutDone'))
    } catch {
      toast(t('nav.logoutFail'))
    }
  }

  return (
    <div className="screen">
      <div className="header compact">
        <div className="brand">{t('mypage.title')}</div>
      </div>
      <main id="main-content" className="content mypage-content" tabIndex={-1}>
        <section className="mypage-user">
          <div className="sb-avatar" aria-hidden="true">👤</div>
          <div className="sb-user-info">
            <div className="sb-name">{displayName}</div>
            <div className="sb-stat">{t('nav.favStat', { fav: favCount, note: noteCount })}</div>
          </div>
        </section>

        {!session && (
          <button className="sb-login" onClick={handleLogin}>
            {t('nav.login')}
          </button>
        )}
        {kind === 'anon' && (
          <button className="sb-login" onClick={handleLogin}>
            🔗 {t('nav.linkData')}
          </button>
        )}

        <section className="mypage-section">
          <button className="mypage-link" onClick={() => navigate('/')}>
            <span className="ic" aria-hidden="true">🏠</span>
            <span>
              <b>{t('mypage.homeSettings')}</b>
              <small>{t('mypage.homeSettingsSub')}</small>
            </span>
            <span className="arrow" aria-hidden="true">›</span>
          </button>
          <button className="mypage-link" onClick={() => navigate('/favorites')}>
            <span className="ic" aria-hidden="true">★</span>
            <span>
              <b>{t('mypage.favorites')}</b>
              <small>{t('mypage.favoritesSub', { count: favCount })}</small>
            </span>
            <span className="arrow" aria-hidden="true">›</span>
          </button>
          <button className="mypage-link" onClick={() => setFamilyOpen(true)}>
            <span className="ic" aria-hidden="true">👨‍👩‍👧</span>
            <span>
              <b>{t('mypage.family')}</b>
              <small>{t('mypage.familySub')}</small>
            </span>
            <span className="arrow" aria-hidden="true">›</span>
          </button>
        </section>

        <section className="mypage-section">
          <h2>{t('mypage.notes')}</h2>
          {needsLogin ? (
            <button className="mypage-empty" onClick={handleLogin}>{t('mypage.loginToShow')}</button>
          ) : noteSchools.length === 0 ? (
            <p className="mypage-empty">{t('mypage.notesEmpty')}</p>
          ) : (
            noteSchools.map((s) => {
              const note = notes[s.id]
              const text = (note?.note || note?.commute_note || '').split('\n')[0]
              return (
                <button className="mypage-card" key={s.id} onClick={() => navigate(`/school/${s.id}`)}>
                  <b>{shortSchoolName(s.name, s)}</b>
                  <small>{text}</small>
                </button>
              )
            })
          )}
        </section>

        <section className="mypage-section">
          <h2>{t('mypage.mine')}</h2>
          {needsLogin ? (
            <button className="mypage-empty" onClick={handleLogin}>{t('mypage.loginToShow')}</button>
          ) : mineSchools.length === 0 ? (
            <p className="mypage-empty">{t('mypage.mineEmpty')}</p>
          ) : (
            mineSchools.map((s) => {
              const record = mine[s.id]
              const values = s.departments
                .map((d) => [d.name, record?.depts[d.id]] as const)
                .filter(([, value]) => value != null)
                .map(([name, value]) => `${name}: ${value}`)
                .join(' / ')
              return (
                <button className="mypage-card" key={s.id} onClick={() => navigate(`/school/${s.id}`)}>
                  <b>{shortSchoolName(s.name, s)}</b>
                  <small>{values || record?.note || fmt.displayCode(s)}</small>
                </button>
              )
            })
          )}
        </section>

        {session && (
          <button className="mypage-logout" onClick={() => void handleSignOut()}>
            {t('nav.logout')}
          </button>
        )}
      </main>
      <FamilyShareSheet open={familyOpen} onClose={() => setFamilyOpen(false)} />
    </div>
  )
}
