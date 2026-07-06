import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useSchools } from '../hooks/useSchools'
import { shortSchoolName } from '../lib/format'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeKey } from '../hooks/useEscapeKey'
import {
  useFamilyShare,
  type FamilyGroupView,
  type SharedFavorite,
  type SharedNote,
} from '../hooks/useFamilyShare'

interface Props {
  open: boolean
  onClose: () => void
}

export function FamilyShareSheet({ open, onClose }: Props) {
  const { toast, setLoginOpen } = useApp()
  const { kind } = useAuth()
  const { t } = useI18n()
  const { schools } = useSchools()
  const family = useFamilyShare()
  const sheetRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [inviteUrls, setInviteUrls] = useState<Record<string, string>>({})
  const [sharedFor, setSharedFor] = useState<string | null>(null)
  const [sharedFavs, setSharedFavs] = useState<SharedFavorite[]>([])
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([])

  useFocusTrap(sheetRef, open)
  useEscapeKey(onClose, open)

  // シートを閉じたら一時状態をリセット
  useEffect(() => {
    if (!open) {
      setInviteUrls({})
      setSharedFor(null)
      setSharedFavs([])
      setSharedNotes([])
    }
  }, [open])

  const schoolName = (id: string) => {
    const s = schools.find((x) => x.id === id)
    return s ? shortSchoolName(s.name) : t('common.schoolUnknown')
  }

  const lineShareUrl = (inviteUrl: string): string => {
    const text = t('family.lineShareMessage', { url: inviteUrl })
    return `https://line.me/R/msg/text/?${encodeURIComponent(text)}`
  }

  const withBusy = async (fn: () => Promise<void>, failMsg: string) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      console.error(failMsg, (err as Error)?.message)
      toast(failMsg)
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = () =>
    withBusy(async () => {
      await family.createGroup('家族')
      toast(t('family.createDone'))
    }, t('family.createFail'))

  const handleInvite = (groupId: string) =>
    withBusy(async () => {
      const url = await family.createInviteUrl(groupId)
      setInviteUrls((cur) => ({ ...cur, [groupId]: url }))
    }, t('family.inviteFail'))

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast(t('family.copyDone'))
    } catch {
      toast(t('family.copyFail'))
    }
  }

  const handleToggleShare = (g: FamilyGroupView, fav: boolean, notes: boolean) =>
    withBusy(async () => {
      await family.setShare(g.id, fav, notes)
    }, t('family.shareFail'))

  const handleLeave = (groupId: string) =>
    withBusy(async () => {
      await family.leaveGroup(groupId)
      toast(t('family.leaveDone'))
    }, t('family.leaveFail'))

  const handleDelete = (groupId: string) =>
    withBusy(async () => {
      await family.deleteGroup(groupId)
      toast(t('family.deleteDone'))
    }, t('family.deleteFail'))

  const handleRemove = (memberId: string) =>
    withBusy(async () => {
      await family.removeMember(memberId)
      toast(t('family.removeDone'))
    }, t('family.removeFail'))

  const handleLoadShared = (groupId: string) =>
    withBusy(async () => {
      if (sharedFor === groupId) {
        setSharedFor(null)
        return
      }
      const [favs, notes] = await Promise.all([
        family.loadSharedFavorites(groupId),
        family.loadSharedNotes(groupId),
      ])
      setSharedFavs(favs)
      setSharedNotes(notes)
      setSharedFor(groupId)
    }, t('family.loadFail'))

  const needsLogin = kind === 'anon' || kind === null

  if (!open) return null

  return (
    <div
      ref={sheetRef}
      className="sheet auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="family-share-title"
    >
      <button className="handle" onClick={onClose} aria-label={t('common.close')} />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title" id="family-share-title">
            {t('family.title')}
          </h3>
        </span>
        <button className="sheet-close" onClick={onClose} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="body">
        <p className="login-note">{t('family.note')}</p>

        {needsLogin && (
          <>
            <p className="login-caution">{t('family.needLogin')}</p>
            <button className="cta" onClick={() => { onClose(); setLoginOpen(true) }}>
              {t('family.startLogin')}
            </button>
          </>
        )}

        {!needsLogin && (
          <>
            {family.loading && family.groups.length === 0 && (
              <p className="mydata-note">{t('common.loading')}</p>
            )}

            {!family.loading && family.groups.length === 0 && (
              <>
                <p className="mydata-note">{t('family.noGroup')}</p>
                <button className="cta" onClick={() => void handleCreate()} disabled={busy}>
                  {t('family.create')}
                </button>
              </>
            )}

            {family.groups.map((g) => {
              const url = inviteUrls[g.id]
              const isOwner = g.myRole === 'owner'
              return (
                <div key={g.id} className="family-group" style={groupBox}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{g.name}</strong>
                    <span className="mydata-note" style={{ margin: 0 }}>
                      {isOwner ? t('family.youOwner') : t('family.member')}
                    </span>
                  </div>

                  {/* メンバー一覧 */}
                  <ul style={memberList}>
                    {g.members.map((m) => (
                      <li key={m.id} style={memberRow}>
                        <span>
                          {m.role === 'owner' ? '👑 ' : '👤 '}
                          {m.is_me
                            ? t('family.you')
                            : m.status === 'invited'
                              ? t('family.invited')
                              : t('family.member')}
                        </span>
                        {isOwner && !m.is_me && (
                          <button
                            className="chip"
                            onClick={() => void handleRemove(m.id)}
                            disabled={busy}
                          >
                            {t('family.remove')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>

                  {/* 自分の共有スコープ */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    <button
                      className={`chip ${g.myShareFavorites ? 'on' : ''}`}
                      onClick={() => void handleToggleShare(g, !g.myShareFavorites, g.myShareNotes)}
                      disabled={busy}
                    >
                      {g.myShareFavorites ? t('family.shareFavOn') : t('family.shareFav')}
                    </button>
                    <button
                      className={`chip ${g.myShareNotes ? 'on' : ''}`}
                      onClick={() => void handleToggleShare(g, g.myShareFavorites, !g.myShareNotes)}
                      disabled={busy}
                    >
                      {g.myShareNotes ? t('family.shareNoteOn') : t('family.shareNote')}
                    </button>
                  </div>

                  {/* 招待（owner のみ） */}
                  {isOwner && (
                    <div style={{ marginTop: 10 }}>
                      <button className="cta secondary" onClick={() => void handleInvite(g.id)} disabled={busy}>
                        {t('family.inviteLink')}
                      </button>
                      {url && (
                        <div style={{ marginTop: 8 }}>
                          <div style={inviteUrlBox}>{url}</div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button className="chip" onClick={() => void handleCopy(url)}>
                              {t('family.copy')}
                            </button>
                            <a
                              className="chip"
                              href={lineShareUrl(url)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t('family.lineSend')}
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 家族の共有データを見る */}
                  <button
                    className="chip"
                    style={{ marginTop: 10 }}
                    onClick={() => void handleLoadShared(g.id)}
                    disabled={busy}
                  >
                    {sharedFor === g.id ? t('family.closeShared') : t('family.viewShared')}
                  </button>

                  {sharedFor === g.id && (
                    <div style={{ marginTop: 8 }}>
                      {sharedFavs.length === 0 && sharedNotes.length === 0 && (
                        <p className="mydata-note">{t('family.sharedEmpty')}</p>
                      )}
                      {sharedFavs.length > 0 && (
                        <>
                          <div className="mydata-note" style={{ marginTop: 0 }}>{t('family.sharedFavs')}</div>
                          <ul style={memberList}>
                            {sharedFavs.map((f, i) => (
                              <li key={`f-${i}`} style={memberRow}>
                                <span>★ {schoolName(f.school_id)}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {sharedNotes.filter((n) => n.note || n.commute_note).length > 0 && (
                        <>
                          <div className="mydata-note">{t('family.sharedNotes')}</div>
                          <ul style={memberList}>
                            {sharedNotes
                              .filter((n) => n.note || n.commute_note)
                              .map((n, i) => (
                                <li key={`n-${i}`} style={{ ...memberRow, display: 'block' }}>
                                  <div>📝 {schoolName(n.school_id)}</div>
                                  <div className="mydata-note" style={{ margin: '2px 0 0' }}>
                                    {(n.note || n.commute_note).split('\n')[0]}
                                  </div>
                                </li>
                              ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}

                  {/* 退出 / 解散 */}
                  <div style={{ marginTop: 12 }}>
                    {isOwner ? (
                      <button className="family-danger" style={dangerBtn} onClick={() => void handleDelete(g.id)} disabled={busy}>
                        {t('family.deleteGroup')}
                      </button>
                    ) : (
                      <button className="family-danger" style={dangerBtn} onClick={() => void handleLeave(g.id)} disabled={busy}>
                        {t('family.leaveGroup')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            {family.groups.length > 0 && (
              <button className="cta secondary" style={{ marginTop: 14 }} onClick={() => void handleCreate()} disabled={busy}>
                {t('family.createAnother')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const groupBox: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '12px 14px',
  marginTop: 12,
}
const memberList: CSSProperties = { listStyle: 'none', padding: 0, margin: '8px 0 0' }
const memberRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '4px 0',
  fontSize: '0.9rem',
}
const inviteUrlBox: CSSProperties = {
  fontSize: '0.78rem',
  wordBreak: 'break-all',
  background: 'var(--paper, #fff)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '8px 10px',
  color: 'var(--ink-soft)',
}
const dangerBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#c0392b',
  fontSize: '0.85rem',
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
}