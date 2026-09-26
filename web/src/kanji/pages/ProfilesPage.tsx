// 学習者の一覧の画面（C8・子 plan「作業内容」3）。
// ヘッダーはページでは描かず、routing.ts の ROUTE_TABLE に登録済み（variant 'brand'。C6 の仕組み）。
// カードの見た目は C7 の ProfileSheet と同じ .mypage-link（house tokens のクラス）を再利用する
// （D-14: 見本の CSS を丸ごと移植せず、既存のクラスを再利用する）。
//
// ProfileSheet と違い、これは常設のページなので選んだ後は自分で / へ移動する（ProfileSheet は
// シートを閉じるだけで背後のページに留まる。ここには「背後のページ」が無い）。

import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n/I18nProvider'
import { levelParts } from '../lib/levels'
import { ROUTES } from '../routing'
import { useProfiles } from '../state/ProfileProvider'

export function ProfilesPage() {
  const { t } = useI18n()
  const { profiles, switchProfile } = useProfiles()
  const navigate = useNavigate()

  function handlePick(id: string) {
    // should: 保存が失敗しても、このページは追加のエラー表示を持たない（C7 の ProfileSheet と
    // 同じ考え方）。失敗時は一覧のまま留まり、/ へは移動しない。
    void switchProfile(id)
      .then(() => navigate(ROUTES.home))
      .catch(() => {})
  }

  return (
    <>
      <h1 className="catch">{t('profiles.title')}</h1>
      <p className="sub">{t('profiles.sub')}</p>
      <div className="mypage-section">
        {profiles.map((profile) => {
          const parts = levelParts(profile.level)
          const levelKey = parts.pre ? 'level.namePreEq' : 'level.nameEq'
          const initial = Array.from(profile.nickname)[0] ?? ''
          return (
            <button key={profile.id} type="button" className="mypage-link" onClick={() => handlePick(profile.id)}>
              <span className="avatar" style={{ background: profile.color }}>
                {initial}
              </span>
              <span>
                <b>{profile.nickname}</b>
                <small>{t(levelKey, { n: parts.n })}</small>
              </span>
              <span className="arrow" aria-hidden="true">
                ›
              </span>
            </button>
          )
        })}
      </div>
      <Link className="mypage-link" to={ROUTES.profileNew}>
        <span className="ic" aria-hidden="true">
          ＋
        </span>
        <span>
          <b>{t('profiles.add')}</b>
        </span>
      </Link>
    </>
  )
}
