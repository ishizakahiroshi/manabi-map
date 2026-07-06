import { useEffect, useState, type CSSProperties } from 'react'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useSchools } from '../hooks/useSchools'
import { shortSchoolName } from '../lib/format'
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

/** LINE Share（トークではなくメッセージ共有）用 URL */
function lineShareUrl(inviteUrl: string): string {
  const text = `Manabi Map の家族グループに招待します。\n下のリンクを開いてログインすると、お気に入りやメモを一緒に見られます。\n${inviteUrl}`
  return `https://line.me/R/msg/text/?${encodeURIComponent(text)}`
}

export function FamilyShareSheet({ open, onClose }: Props) {
  const { toast, setLoginOpen } = useApp()
  const { kind } = useAuth()
  const { schools } = useSchools()
  const family = useFamilyShare()
  const [busy, setBusy] = useState(false)
  const [inviteUrls, setInviteUrls] = useState<Record<string, string>>({})
  const [sharedFor, setSharedFor] = useState<string | null>(null)
  const [sharedFavs, setSharedFavs] = useState<SharedFavorite[]>([])
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([])

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
    return s ? shortSchoolName(s.name) : '（学校情報を取得できませんでした）'
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
      toast('家族グループを作りました')
    }, '家族グループを作れませんでした')

  const handleInvite = (groupId: string) =>
    withBusy(async () => {
      const url = await family.createInviteUrl(groupId)
      setInviteUrls((cur) => ({ ...cur, [groupId]: url }))
    }, '招待リンクを作れませんでした')

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast('招待リンクをコピーしました')
    } catch {
      toast('コピーできませんでした。リンクを長押しで選択してください')
    }
  }

  const handleToggleShare = (g: FamilyGroupView, fav: boolean, notes: boolean) =>
    withBusy(async () => {
      await family.setShare(g.id, fav, notes)
    }, '共有設定を変更できませんでした')

  const handleLeave = (groupId: string) =>
    withBusy(async () => {
      await family.leaveGroup(groupId)
      toast('家族グループから退出しました')
    }, '退出できませんでした')

  const handleDelete = (groupId: string) =>
    withBusy(async () => {
      await family.deleteGroup(groupId)
      toast('家族グループを解散しました')
    }, '解散できませんでした')

  const handleRemove = (memberId: string) =>
    withBusy(async () => {
      await family.removeMember(memberId)
      toast('メンバーを解除しました')
    }, '解除できませんでした')

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
    }, '家族の共有データを読み込めませんでした')

  const needsLogin = kind === 'anon' || kind === null

  return (
    <div className={`sheet auto ${open ? '' : 'hidden'}`} aria-hidden={!open}>
      <button className="handle" onClick={onClose} aria-label="閉じる" />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title">家族で共有</h3>
        </span>
        <button className="sheet-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>
      <div className="body">
        <p className="login-note">
          家族（親子）でお気に入りとメモを共有できます。招待リンクを送り、相手がログインして受け取ると一緒に見られます。
        </p>

        {needsLogin && (
          <>
            <p className="login-caution">
              家族共有には LINE または Google ログインが必要です（匿名では別デバイスと共有できません）。
            </p>
            <button className="cta" onClick={() => { onClose(); setLoginOpen(true) }}>
              ログインして始める
            </button>
          </>
        )}

        {!needsLogin && (
          <>
            {family.loading && family.groups.length === 0 && (
              <p className="mydata-note">読み込み中…</p>
            )}

            {!family.loading && family.groups.length === 0 && (
              <>
                <p className="mydata-note">まだ家族グループがありません。</p>
                <button className="cta" onClick={() => void handleCreate()} disabled={busy}>
                  ＋ 家族グループを作る
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
                      {isOwner ? 'あなたが作成' : 'メンバー'}
                    </span>
                  </div>

                  {/* メンバー一覧 */}
                  <ul style={memberList}>
                    {g.members.map((m) => (
                      <li key={m.id} style={memberRow}>
                        <span>
                          {m.role === 'owner' ? '👑 ' : '👤 '}
                          {m.is_me ? 'あなた' : m.status === 'invited' ? '招待中（未受諾）' : 'メンバー'}
                        </span>
                        {isOwner && !m.is_me && (
                          <button
                            className="chip"
                            onClick={() => void handleRemove(m.id)}
                            disabled={busy}
                          >
                            解除
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
                      ★ お気に入りを共有{g.myShareFavorites ? '中' : ''}
                    </button>
                    <button
                      className={`chip ${g.myShareNotes ? 'on' : ''}`}
                      onClick={() => void handleToggleShare(g, g.myShareFavorites, !g.myShareNotes)}
                      disabled={busy}
                    >
                      📝 メモを共有{g.myShareNotes ? '中' : ''}
                    </button>
                  </div>

                  {/* 招待（owner のみ） */}
                  {isOwner && (
                    <div style={{ marginTop: 10 }}>
                      <button className="cta secondary" onClick={() => void handleInvite(g.id)} disabled={busy}>
                        ＋ 招待リンクを作る
                      </button>
                      {url && (
                        <div style={{ marginTop: 8 }}>
                          <div style={inviteUrlBox}>{url}</div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button className="chip" onClick={() => void handleCopy(url)}>
                              リンクをコピー
                            </button>
                            <a
                              className="chip"
                              href={lineShareUrl(url)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              LINE で送る
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
                    {sharedFor === g.id ? '家族の共有を閉じる' : '家族の志望校・メモを見る'}
                  </button>

                  {sharedFor === g.id && (
                    <div style={{ marginTop: 8 }}>
                      {sharedFavs.length === 0 && sharedNotes.length === 0 && (
                        <p className="mydata-note">共有されているデータはまだありません。</p>
                      )}
                      {sharedFavs.length > 0 && (
                        <>
                          <div className="mydata-note" style={{ marginTop: 0 }}>家族の志望校</div>
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
                          <div className="mydata-note">家族のメモ</div>
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
                        このグループを解散する
                      </button>
                    ) : (
                      <button className="family-danger" style={dangerBtn} onClick={() => void handleLeave(g.id)} disabled={busy}>
                        このグループから退出する
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            {family.groups.length > 0 && (
              <button className="cta secondary" style={{ marginTop: 14 }} onClick={() => void handleCreate()} disabled={busy}>
                ＋ 別の家族グループを作る
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
