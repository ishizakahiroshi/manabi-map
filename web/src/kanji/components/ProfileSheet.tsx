// 学習者を切り替えるシート（C7・子 plan「作業内容」2）。
// 学習者ごとに色の丸・ニックネーム・級の名前（「○級相当」表記の level.nameEq / level.namePreEq。
// ヘッダーの ProfileChip・学習者の追加と編集の級のチップも同じキーを使う。指示書 §2・2026-09-24
// C9 レビュー must 2 で揃えた。level.name / level.namePre「○級」は、この統一でどこからも
// 使われなくなったため ja.json / en.json から削除した）を並べ、選ぶと switchProfile して閉じる。
// 最後に「＋ 学習者を追加」（/profiles/new へ）。
//
// LanguageSheet と同じ .sheet auto の枠・閉じ方（handle・sheet-close・背景・Esc）・フォーカスの
// 扱い（lib/useFocusTrap.ts）にする（子 plan の作業内容に個別の指定が無い軽い迷いなので、同じ
// 見た目の兄弟コンポーネントに倣った。子 plan「このファイルを開いた AI へ」）。
//
// 「＋ 学習者を追加」は <Link to={ROUTES.profileNew}>（'/profiles/new'。routing.ts の ROUTES。
// C10 N3）にしてある（C7 レビュー should 3）。
// renderToString だけで見え方を確かめるこのプロジェクトのテストの流儀では、onClick で
// navigate() する作りだと行き先が HTML に出ず確かめられないため、行き先が href として直接
// 出る Link にした（KanjiApp.tsx の NotFoundPage の Link と同じ考え方）。

import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../i18n/I18nProvider'
import { levelParts } from '../lib/levels'
import { useFocusTrap } from '../lib/useFocusTrap'
import { ROUTES } from '../routing'
import { useProfiles } from '../state/ProfileProvider'

export interface ProfileSheetProps {
  onClose: () => void
  /** いまの画面に下のタブが無ければ true（KanjiLayout が routing.ts の entry.tab から渡す。should 1） */
  noTabs: boolean
}

const HEADING_ID = 'kanji-profile-sheet-title'

export function ProfileSheet({ onClose, noTabs }: ProfileSheetProps) {
  const { t, text } = useI18n()
  const { profiles, currentId, switchProfile } = useProfiles()
  const sheetRef = useRef<HTMLDivElement>(null)

  // ProfileSheet も LanguageSheet と同じくマウント＝開く（LoginSheet 流）。
  useFocusTrap(sheetRef, true)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handlePick(id: string) {
    // should 2: 保存が失敗しても（このシートはエラー表示を持たない）、処理されない例外を出さない。
    void switchProfile(id).catch(() => {})
    onClose()
  }

  return (
    <>
      <button
        type="button"
        className="sheet-backdrop"
        onClick={onClose}
        aria-label={text('common.close')}
        tabIndex={-1}
      />
      <div
        ref={sheetRef}
        className={noTabs ? 'sheet auto no-tabs' : 'sheet auto'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={HEADING_ID}
      >
        <button type="button" className="handle" onClick={onClose} aria-label={text('common.close')} />
        <div className="head">
          <span className="grow">
            <h3 className="detail-title" id={HEADING_ID}>
              {t('profiles.switch')}
            </h3>
          </span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label={text('common.close')}>
            ×
          </button>
        </div>
        <div className="body">
          {profiles.map((profile) => {
            const parts = levelParts(profile.level)
            const levelKey = parts.pre ? 'level.namePreEq' : 'level.nameEq'
            const initial = Array.from(profile.nickname)[0] ?? ''
            const isCurrent = profile.id === currentId
            return (
              <button
                key={profile.id}
                type="button"
                className="mypage-link"
                onClick={() => handlePick(profile.id)}
              >
                <span className="avatar" style={{ background: profile.color }}>
                  {initial}
                </span>
                <span>
                  <b>{profile.nickname}</b>
                  <small>{t(levelKey, { n: parts.n })}</small>
                </span>
                {isCurrent && <span className="tag accent">{t('profiles.current')}</span>}
              </button>
            )
          })}
          <Link className="mypage-link" to={ROUTES.profileNew} onClick={onClose}>
            <span>
              <b>{t('profiles.add')}</b>
            </span>
          </Link>
        </div>
      </div>
    </>
  )
}
