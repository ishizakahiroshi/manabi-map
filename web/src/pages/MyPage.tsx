import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { shortSchoolName } from '../lib/format'
import { formatHomeCoordinates, useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { FamilyShareSheet } from '../components/FamilyShareSheet'
import { SiteMoveGuestNotice } from '../components/SiteMoveNotice'
import { countMyData } from '../lib/export'
import './MyPage.css'
import { savedSchoolEntries, savedDepartmentValues } from '../lib/saved-school-references'
import { SavedSchoolReference } from '../components/SavedSchoolReference'

interface Props {
  userData: ReturnType<typeof useUserData>
  favCount: number
  noteCount: number
}

export function MyPage({ userData, favCount, noteCount }: Props) {
  const navigate = useNavigate()
  const { schools, loading: schoolsLoading, error: schoolsError } = useSchools()
  const { home, homeLoadState, setLoginOpen, toast } = useApp()
  const { session, kind, displayName, signOut } = useAuth()
  const { t } = useI18n()
  const { notes, mine, deleteNote, deleteMine } = userData
  const [familyOpen, setFamilyOpen] = useState(false)

  const noteSchools = useMemo(
    () =>
      savedSchoolEntries(schools, notes)
        .filter(({ record }) => record.note || record.commute_note)
        .sort((a, b) => (a.school ? shortSchoolName(a.school.name, a.school) : a.id).localeCompare(b.school ? shortSchoolName(b.school.name, b.school) : b.id, 'ja')),
    [schools, notes],
  )

  const mineSchools = useMemo(
    () =>
      savedSchoolEntries(schools, mine)
        .filter(({ record }) => record.note.trim() !== '' || Object.values(record.depts).some((v) => v != null))
        .sort((a, b) => (a.school ? shortSchoolName(a.school.name, a.school) : a.id).localeCompare(b.school ? shortSchoolName(b.school.name, b.school) : b.id, 'ja')),
    [schools, mine],
  )

  const hasUserData = useMemo(
    () => countMyData({ favorites: userData.favorites, notes, mine }) > 0,
    [userData.favorites, notes, mine],
  )

  const needsLogin = !session || kind === 'anon'
  const homeCoordinates = home ? formatHomeCoordinates(home) : null

  const handleLogin = () => setLoginOpen(true)

  const handleSignOut = async () => {
    try {
      await signOut()
      toast(t('nav.logoutDone'))
    } catch {
      toast(t('nav.logoutFail'))
    }
  }

  const handleDeleteNote = async (schoolId: string, schoolName: string) => {
    if (!window.confirm(t('mypage.deleteNoteConfirm', { school: schoolName }))) return
    try {
      const status = await deleteNote(schoolId)
      if (status === 'success') toast(t('mypage.deleteNoteDone'))
    } catch {
      toast(t('mypage.deleteNoteFail'))
    }
  }

  const handleDeleteMine = async (schoolId: string, schoolName: string) => {
    if (!window.confirm(t('mypage.deleteMineConfirm', { school: schoolName }))) return
    try {
      const status = await deleteMine(schoolId)
      if (status === 'success') toast(t('mypage.deleteMineDone'))
    } catch {
      toast(t('mypage.deleteMineFail'))
    }
  }

  return (
    <div className="screen">
      <div className="header compact">
        <div className="brand">{t('mypage.title')}</div>
      </div>
      <main id="main-content" className="content mypage-content" tabIndex={-1}>
        <SiteMoveGuestNotice hasUserData={hasUserData} />
        <section className="mypage-user">
          <div className="sb-avatar" aria-hidden="true">👤</div>
          <div className="sb-user-info">
            <div className="sb-name">{displayName}</div>
            <div className="sb-stat">{t('nav.favStat', { fav: favCount, note: noteCount })}</div>
          </div>
          {session && (
            <button type="button" className="mypage-logout" onClick={() => void handleSignOut()}>
              {t('nav.logout')}
            </button>
          )}
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
            <span className="mypage-home-details" aria-live="polite">
              <b>{t('mypage.homeSettings')}</b>
              {homeLoadState === 'loading' && (
                <small className="mypage-home-status">{t('mypage.homeSettingsLoading')}</small>
              )}
              {homeLoadState === 'error' && (
                <>
                  <small className="mypage-home-status mypage-home-error">{t('mypage.homeSettingsError')}</small>
                  <small>{t('mypage.homeSettingsSub')}</small>
                </>
              )}
              {homeLoadState === 'ready' && home && homeCoordinates && (
                <>
                  <small className="mypage-home-status">{t('mypage.homeSettingsSet')}</small>
                  <small className="mypage-home-location" title={home.label}>
                    <span className="sr-only">{t('mypage.homeLocation')}: </span>
                    <span aria-hidden="true">📍</span>{' '}{home.label}
                  </small>
                  <small className="mypage-home-coordinates">
                    {t('mypage.homeCoordinates', homeCoordinates)}
                  </small>
                </>
              )}
              {homeLoadState === 'ready' && !home && (
                <>
                  <small className="mypage-home-status">{t('mypage.homeSettingsUnset')}</small>
                  <small>{t('mypage.homeSettingsSub')}</small>
                </>
              )}
              {homeLoadState === 'ready' && home && !homeCoordinates && (
                <>
                  <small className="mypage-home-status mypage-home-error">{t('mypage.homeSettingsError')}</small>
                  <small>{t('mypage.homeSettingsSub')}</small>
                </>
              )}
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
            noteSchools.map(({ id, school: s, record: note }) => {
              const text = s ? (note.note || note.commute_note || '').split('\n')[0] : [note.note, note.commute_note].filter(Boolean).join('\n')
              const schoolName = s ? shortSchoolName(s.name, s) : t('savedSchool.unavailable')
              return (
                <article className="mypage-card mypage-note-card" key={id}>
                  {s ? <button
                    type="button"
                    className="mypage-card-main"
                    onClick={() => navigate(`/school/${s.id}`)}
                  >
                    <b>{schoolName}</b>
                    <small>{text}</small>
                  </button> : <div className="mypage-card-main saved-school-unavailable">
                    <b>{schoolName}</b>
                    <SavedSchoolReference id={id} loading={schoolsLoading} error={schoolsError} />
                    <small className="saved-school-content">{text}</small>
                  </div>}
                  <button
                    type="button"
                    className="mypage-card-delete"
                    aria-label={t('mypage.deleteNote', { school: s ? schoolName : `${schoolName} (${id})` })}
                    onClick={() => void handleDeleteNote(id, s ? schoolName : `${schoolName} (${id})`)}
                  >
                    <span aria-hidden="true">🗑️</span>
                  </button>
                </article>
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
            mineSchools.map(({ id, school: s, record }) => {
              const departmentValues = savedDepartmentValues(s, record)
              const hasUnavailableDepartment = departmentValues.some(({ name }) => name === undefined)
              const values = departmentValues
                .map(({ id: departmentId, name, value }) => `${name ?? t('savedSchool.department', { id: departmentId })}: ${value}`)
                .join(' / ')
              const schoolName = s ? shortSchoolName(s.name, s) : t('savedSchool.unavailable')
              return (
                <article className="mypage-card mypage-mine-card" key={id}>
                  {s ? <button
                    type="button"
                    className="mypage-card-main"
                    onClick={() => navigate(`/school/${s.id}`)}
                  >
                    <b>{schoolName}</b>
                    <small className={hasUnavailableDepartment ? 'saved-school-content' : undefined}>{values || record.note}</small>
                    {hasUnavailableDepartment && record.note && <small className="saved-school-content">{record.note}</small>}
                  </button> : <div className="mypage-card-main saved-school-unavailable">
                    <b>{schoolName}</b>
                    <SavedSchoolReference id={id} loading={schoolsLoading} error={schoolsError} />
                    {values && <small className="saved-school-content">{values}</small>}
                    {record.note && <small className="saved-school-content">{record.note}</small>}
                  </div>}
                  <button
                    type="button"
                    className="mypage-card-delete"
                    aria-label={t('mypage.deleteMine', { school: s ? schoolName : `${schoolName} (${id})` })}
                    onClick={() => void handleDeleteMine(id, s ? schoolName : `${schoolName} (${id})`)}
                  >
                    <span aria-hidden="true">🗑️</span>
                  </button>
                </article>
              )
            })
          )}
        </section>
      </main>
      <FamilyShareSheet open={familyOpen} onClose={() => setFamilyOpen(false)} />
    </div>
  )
}
