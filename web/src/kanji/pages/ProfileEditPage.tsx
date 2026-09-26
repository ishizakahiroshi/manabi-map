// 学習者の追加・編集の画面（C8・子 plan「作業内容」4）。
// /profiles/new（追加）と /profiles/:id（編集）を 1 つのコンポーネントで扱う（id が無ければ追加）。
// ヘッダーはページでは描かず、routing.ts の ROUTE_TABLE に登録済み（variant 'back'。C6 の仕組み）。
// 項目と並びは見本の SCREENS.profileEdit のとおり（子 plan「調査で確認した現在の実装」）。
//
// ことばは components/EditLangField.tsx（C7 の LanguageSheet を value・onSelect 付きで開く部品）
// を使う。onSelect のあるときの LanguageSheet は setUiLang を呼ばず、選んだ言語コードを渡して
// 閉じるだけなので（components/LanguageSheet.tsx 冒頭のコメント）、ここではフォームの値だけが
// 変わり、ほかの学習者・画面全体の言語は変えない（子 plan「作業内容」4）。
//
// 保存後の navigator.storage.persist()（requestPersistence）は KanjiStore が要る。
// state/ProfileProvider.tsx（C5）は KanjiStore を context に出していない（C5 のファイルは変えない。
// 子 plan「守ること」）ため、KanjiApp.tsx（C6・「つなぐ」範囲）が props としてこのページまで
// store を運ぶ（KanjiApp.tsx の pageElementFor を参照）。
//
// must 1（2026-09-24 C8 レビュー）: /profiles/:id の id に一致する学習者がいなければ、フォームを
// 出さず /profiles へ置き換え遷移する。学習者が見つからないまま保存すると、existing が null に
// なって新規追加の扱いになり、意図せず学習者が増えてしまうため。
//
// must 2（同レビュー）: 二重送信を防ぐため、送信中の ref（submittingRef）と表示用の state
// （submitting）を持つ。実際の保存の流れ（検証 → 追加/更新 → 後始末）は lib/saveProfileForm.ts
// の純粋な async 関数に出し、その関数自身にも同じ guard を持たせた（呼び出しを連続 2 回行っても
// 保存は 1 回だけになることを lib/saveProfileForm.test.ts で確かめてある）。
//
// should 1（同レビュー）: 入力欄に aria-invalid・aria-describedby を付け、送信に失敗したら最初の
// 不正な欄へ focus を移す。保存全体の失敗（edit.saveError）には role="alert" を付ける。級の band の
// 見出しはチップの群と role="group"・aria-labelledby でつなぐ。
//
// 2026-09-24 C8 再レビュー・申し送り:
// 1. 新しい学習者の id は lib/saveProfileForm.ts の try の中で作る（createProfileId を渡すだけ）。
//    保存に成功したときは submittingRef（guard）を戻さない（lib/saveProfileForm.ts 側の設計）ので、
//    ここでも setSubmitting(false) は 'saved' 以外の分岐でだけ呼ぶ（画面を離れるまでボタンを
//    disabled のままにして、遷移が終わるまでの一瞬にもう一度押せてしまわないようにする）。
// 2. 送信の検証エラーは非同期（saveProfileForm の Promise）で届くため、setErrors 直後に focus を
//    呼ぶと、その setErrors がまだ DOM に反映されていないことがある。errors の変化を見る
//    useEffect の中で focus することで、React が DOM を更新し終えたことを保証してから移す。

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { EditLangField } from '../components/EditLangField'
import { useI18n } from '../i18n/I18nProvider'
import { examFieldAria, nickFieldAria } from '../lib/fieldAria'
import { LEVELS, levelParts, type LevelBand } from '../lib/levels'
import {
  defaultProfileForm,
  profileToForm,
  SCHOOL_LEVEL_ENTRIES,
  updateFormField,
  type ProfileFormInput,
} from '../lib/profileForm'
import { createProfileId, saveProfileForm } from '../lib/saveProfileForm'
import type { KanjiStore } from '../lib/store'
import { getHistoryIndex } from '../platform/browser'
import { ROUTES, shouldReplaceBack } from '../routing'
import { useProfiles } from '../state/ProfileProvider'
import { DAILY_GOALS, PROFILE_COLORS, type DisplayMode, type FuriganaMode, type WriteMode } from '../types'

const FURIGANA_OPTIONS: { value: FuriganaMode; labelKey: string }[] = [
  { value: 'all', labelKey: 'furi.all' },
  { value: 'unlearned', labelKey: 'furi.unlearned' },
  { value: 'none', labelKey: 'furi.none' },
]

const WRITE_OPTIONS: { value: WriteMode; labelKey: string }[] = [
  { value: 'auto', labelKey: 'write.auto' },
  { value: 'screen', labelKey: 'write.screen' },
  { value: 'paper', labelKey: 'write.paper' },
]

const BAND_ORDER: LevelBand[] = ['es', 'jh', 'hs', 'ad']
const BAND_LABEL_KEY: Record<LevelBand, string> = {
  es: 'band.es',
  jh: 'band.jh',
  hs: 'band.hs',
  ad: 'band.ad',
}

export interface ProfileEditPageProps {
  store: KanjiStore
}

/**
 * 保存全体の失敗（子 plan の edit.saveError）を role="alert" で伝える小さな部品（should 1）。
 * show を外から渡す形にして、ProfileEditPage.tsx 本体の state（クリックで初めて true になる）を
 * 経由しなくても、pages/pages.test.ts から show={true} を直接渡して role="alert" の描画を
 * 確かめられるようにする（EditLangField.tsx の open と同じ考え方）。
 */
export function SaveErrorAlert({ show }: { show: boolean }) {
  const { t } = useI18n()
  if (!show) return null
  return (
    <p className="mini-hint bad" role="alert">
      {t('edit.saveError')}
    </p>
  )
}

export function ProfileEditPage({ store }: ProfileEditPageProps) {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { t, text, lang: uiLang } = useI18n()
  const { profiles, addProfile, updateProfile, removeProfile } = useProfiles()

  const isNew = id === undefined
  const existing = isNew ? null : (profiles.find((p) => p.id === id) ?? null)
  // must 1: id はあるのに一致する学習者がいない（消された・URL を直接触った等）。
  const notFoundInEdit = !isNew && !existing

  const [form, setForm] = useState<ProfileFormInput>(() =>
    existing ? profileToForm(existing) : defaultProfileForm(uiLang),
  )
  const [levelView, setLevelView] = useState<'level' | 'school'>('level')
  const [errors, setErrors] = useState<{ nickname?: 'edit.nickError'; examDate?: 'edit.examError' }>({})
  const [saveError, setSaveError] = useState(false)
  const [langSheetOpen, setLangSheetOpen] = useState(false)
  const [deleteStep, setDeleteStep] = useState(false)
  // must 2: 二重送信防止。ref は同期的に読み書きできるので guard に使い、state は表示（disabled）用。
  // submittingRef 自体が { current: boolean } の形（React の ref の形＝lib/saveProfileForm.ts の
  // SubmitGuard の形と同じ）なので、そのまま saveProfileForm の guard 引数として渡せる。
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  // should 1: 送信に失敗したときに最初の不正な欄へ focus を移すための参照。
  const nickRef = useRef<HTMLInputElement>(null)
  const examRef = useRef<HTMLInputElement>(null)

  // 申し送り 4: updateFormField を setForm の更新関数（prev => ...）の中ではなく、ここで直接
  // 同期的に呼ぶ（setForm(nextValue) の形）。setForm(prev => ...) の形だと、その更新関数は React が
  // 実際に次の描画を処理するときにしか呼ばれない。renderToString は 1 回きりで「次の描画」が
  // 来ないため、SSR のテストから onChange を直接呼んでも updateFormField が呼ばれたことを
  // 観測できなかった。update は毎回 1 回だけ呼ばれる作り（同じイベントの中で連続して呼ぶ箇所は
  // 無い）なので、直前の描画時点の form を閉じ込めて使っても問題ない。
  function update<K extends keyof ProfileFormInput>(key: K, value: ProfileFormInput[K]) {
    setForm(updateFormField(form, key, value))
  }

  // 申し送り 2: 検証エラーが変わったとき（＝送信に失敗したとき）だけ、最初の不正な欄へ focus を
  // 移す。setErrors({}) で errors を空にしたときはどちらの条件にも当たらないので何もしない。
  useEffect(() => {
    if (errors.nickname) nickRef.current?.focus()
    else if (errors.examDate) examRef.current?.focus()
  }, [errors])

  function goBack() {
    // must 3（KanjiLayout.tsx の PageHeader）と同じ判定。保存の直後は「前の画面へ」なので、
    // 戻る先が無ければ / へ置き換え遷移する。
    const idx = getHistoryIndex()
    if (shouldReplaceBack(idx)) navigate(ROUTES.home, { replace: true })
    else navigate(-1)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // must 2: 2 回目（送信中の連打）はここで捨てる。
    if (submittingRef.current) return
    setSubmitting(true)
    const now = new Date().toISOString()
    // 申し送り 1: id 作り（createProfileId）は呼び出し側でなく saveProfileForm の try の中で行う。
    void saveProfileForm(form, existing, now, createProfileId, submittingRef, { addProfile, updateProfile, store })
      .then((outcome) => {
        switch (outcome.kind) {
          case 'skipped':
            setSubmitting(false)
            return
          case 'validation':
            setSubmitting(false)
            setErrors(outcome.errors)
            setSaveError(false)
            // should 1 の focus は、errors の変化を見る useEffect（このファイルの update の下）へ移した
            // （申し送り 2。setErrors 直後はまだ DOM に反映されていないことがあるため）。
            return
          case 'error':
            setSubmitting(false)
            setErrors({})
            setSaveError(true)
            return
          case 'saved':
            // 申し送り 1: saveProfileForm は保存成功時に guard（submittingRef）を戻さない。ここでも
            // setSubmitting(false) を呼ばず、画面を離れる（goBack／navigate）までボタンを disabled の
            // ままにする。呼ぶと、遷移が終わるまでの一瞬にもう一度送信ボタンを押せてしまう。
            setErrors({})
            setSaveError(false)
            if (outcome.mode === 'edit') goBack()
            // should 6: 追加の後の移動は置き換え遷移にする（はじめての画面・追加フォームへ
            // 「戻る」で行き来できてしまわないように）。
            else navigate(ROUTES.home, { replace: true })
            return
        }
      })
  }

  function handleDelete() {
    if (!existing) return
    // must 2: 送信（保存）中は削除も、削除中は送信も始めない。同じ guard を共有する。
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    void removeProfile(existing.id)
      .then(() => navigate(ROUTES.profiles, { replace: true }))
      .catch(() => setSaveError(true))
      .finally(() => {
        submittingRef.current = false
        setSubmitting(false)
      })
  }

  // must 1: 見つからない編集対象は、フォームを描かずに一覧へ置き換え遷移する。すべての hooks を
  // 呼び終えた後の分岐なので react/rules-of-hooks には反しない（hooks の呼び出し順は毎回同じ）。
  if (notFoundInEdit) {
    return <Navigate to={ROUTES.profiles} replace />
  }

  const nickAria = nickFieldAria(Boolean(errors.nickname))
  const examAria = examFieldAria(Boolean(errors.examDate))

  return (
    <>
      <h1 className="about-title">{t(isNew ? 'edit.titleNew' : 'edit.titleEdit')}</h1>
      {/* should 5: .chip の text-align・small・disabled のスタイルはこのフォームの中だけに効かせる
          （kanji.css の .profile-edit-form セレクタを参照。C7 のことばのシートには影響させない）。 */}
      <form className="profile-edit-form" onSubmit={handleSubmit}>
        <label className="form-label" htmlFor="kanji-edit-nick">
          {t('edit.nick')}
        </label>
        <input
          id="kanji-edit-nick"
          ref={nickRef}
          className="input"
          value={form.nickname}
          onChange={(event) => update('nickname', event.target.value)}
          placeholder={text('edit.nickPh')}
          autoComplete="off"
          aria-invalid={nickAria.ariaInvalid}
          aria-describedby={nickAria.ariaDescribedBy}
        />
        <p id="kanji-edit-nick-hint" className="mini-hint soft">
          {t('edit.nickHint')}
        </p>
        {errors.nickname && (
          <p id="kanji-edit-nick-error" className="mini-hint bad">
            {t(errors.nickname)}
          </p>
        )}

        <span className="form-label" id="kanji-edit-lang-label">
          {t('edit.lang')}
        </span>
        <EditLangField
          value={form.lang}
          onChange={(code) => update('lang', code)}
          open={langSheetOpen}
          onOpenChange={setLangSheetOpen}
          labelId="kanji-edit-lang-label"
        />

        <span className="form-label" id="kanji-edit-level-label">
          {t('edit.level')}
        </span>
        <div className="mode-switch" role="group" aria-labelledby="kanji-edit-level-label">
          <button
            type="button"
            className={levelView === 'level' ? 'on' : undefined}
            aria-pressed={levelView === 'level'}
            onClick={() => setLevelView('level')}
          >
            {t('edit.byLevel')}
          </button>
          <button
            type="button"
            className={levelView === 'school' ? 'on' : undefined}
            aria-pressed={levelView === 'school'}
            onClick={() => setLevelView('school')}
          >
            {t('edit.bySchool')}
          </button>
        </div>

        {levelView === 'level' ? (
          BAND_ORDER.map((band) => {
            // should 1: band の見出しとチップの群を role="group"・aria-labelledby でつなぐ。
            const bandLabelId = `kanji-edit-band-${band}`
            return (
              <div className="level-band" key={band}>
                <span id={bandLabelId}>{t(BAND_LABEL_KEY[band])}</span>
                <div className="chip-row" role="group" aria-labelledby={bandLabelId}>
                  {LEVELS.filter((entry) => entry.band === band).map((entry) => {
                    const parts = levelParts(entry.key)
                    // 級のチップは「○級相当」で出す（指示書 §2。2026-09-24 C9 レビュー must 2）。
                    const nameKey = parts.pre ? 'level.namePreEq' : 'level.nameEq'
                    const on = form.level === entry.key
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        className={on ? 'chip on' : 'chip'}
                        aria-pressed={on}
                        disabled={!entry.available}
                        onClick={() => update('level', entry.key)}
                      >
                        {t(nameKey, { n: parts.n })}
                        <small>
                          {t(`level.stage.${entry.key}`)}
                          <br />
                          {entry.approx
                            ? t('level.countApprox', { n: entry.total })
                            : t('level.count', { n: entry.total })}
                          {!entry.available && (
                            <>
                              <br />
                              {t('level.soon')}
                            </>
                          )}
                        </small>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })
        ) : (
          <div className="chip-row" role="group" aria-labelledby="kanji-edit-level-label">
            {SCHOOL_LEVEL_ENTRIES.map((entry) => {
              const parts = levelParts(entry.level)
              const eqKey = parts.pre ? 'level.namePreEq' : 'level.nameEq'
              // 見本と同じ理由: g1（小1）も jsl（日本語を学んでいる）も既定は同じ level '10' を指す
              // ため、level だけで on を判定すると 2 つ同時に光ってしまう。jsl は on 判定から外す。
              const on = form.level === entry.level && entry.key !== 'jsl'
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={on ? 'chip on' : 'chip'}
                  aria-pressed={on}
                  onClick={() => update('level', entry.level)}
                >
                  {t(entry.labelKey)}
                  <small>{t('edit.fromLevel', { level: t(eqKey, { n: parts.n }) })}</small>
                </button>
              )
            })}
          </div>
        )}
        <p className="mini-hint soft">{t('edit.levelHint')}</p>

        <span className="form-label" id="kanji-edit-furigana-label">
          {t('edit.furigana')}
        </span>
        <div className="chip-row" role="group" aria-labelledby="kanji-edit-furigana-label">
          {FURIGANA_OPTIONS.map((opt) => {
            const on = form.furigana === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                className={on ? 'chip on' : 'chip'}
                aria-pressed={on}
                onClick={() => update('furigana', opt.value)}
              >
                {t(opt.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="mini-hint soft">{t('edit.furiHint')}</p>

        <label className="form-label" htmlFor="kanji-edit-exam">
          {t('edit.exam')}
        </label>
        <input
          id="kanji-edit-exam"
          ref={examRef}
          className="input"
          type="date"
          value={form.examDate}
          onChange={(event) => update('examDate', event.target.value)}
          aria-invalid={examAria.ariaInvalid}
          aria-describedby={examAria.ariaDescribedBy}
        />
        {errors.examDate && (
          <p id="kanji-edit-exam-error" className="mini-hint bad">
            {t(errors.examDate)}
          </p>
        )}

        <span className="form-label" id="kanji-edit-goal-label">
          {t('edit.goal')}
        </span>
        <div className="chip-row" role="group" aria-labelledby="kanji-edit-goal-label">
          {DAILY_GOALS.map((goal) => {
            const on = form.dailyGoal === goal
            return (
              <button
                key={goal}
                type="button"
                className={on ? 'chip on' : 'chip'}
                aria-pressed={on}
                onClick={() => update('dailyGoal', goal)}
              >
                {t('edit.goalUnit', { n: goal })}
              </button>
            )
          })}
        </div>

        <span className="form-label" id="kanji-edit-display-label">
          {t('edit.display')}
        </span>
        <div className="chip-row" role="group" aria-labelledby="kanji-edit-display-label">
          {(['child', 'adult'] as DisplayMode[]).map((mode) => {
            const on = form.display === mode
            return (
              <button
                key={mode}
                type="button"
                className={on ? 'chip on' : 'chip'}
                aria-pressed={on}
                onClick={() => update('display', mode)}
              >
                {t(mode === 'child' ? 'display.child' : 'display.adult')}
                <small>{t(mode === 'child' ? 'display.childSub' : 'display.adultSub')}</small>
              </button>
            )
          })}
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={form.kanaKeyboard}
            onChange={(event) => update('kanaKeyboard', event.target.checked)}
          />
          <span>{t('edit.kbd')}</span>
        </label>

        <span className="form-label" id="kanji-edit-write-label">
          {t('edit.write')}
        </span>
        <div className="chip-row" role="group" aria-labelledby="kanji-edit-write-label">
          {WRITE_OPTIONS.map((opt) => {
            const on = form.writeMode === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                className={on ? 'chip on' : 'chip'}
                aria-pressed={on}
                onClick={() => update('writeMode', opt.value)}
              >
                {t(opt.labelKey)}
              </button>
            )
          })}
        </div>

        <span className="form-label" id="kanji-edit-color-label">
          {t('edit.color')}
        </span>
        <div className="chip-row" role="group" aria-labelledby="kanji-edit-color-label">
          {PROFILE_COLORS.map((color, index) => {
            const on = form.color === color
            return (
              <button
                key={color}
                type="button"
                className={on ? 'chip swatch on' : 'chip swatch'}
                aria-pressed={on}
                aria-label={text('edit.colorN', { n: String(index + 1) })}
                style={{ background: color }}
                onClick={() => update('color', color)}
              />
            )
          })}
        </div>

        <SaveErrorAlert show={saveError} />
        <button type="submit" className="cta" disabled={submitting}>
          {t(isNew ? 'edit.submitNew' : 'edit.submitEdit')}
        </button>
      </form>

      {!isNew && existing && (
        <div className="mypage-section">
          {!deleteStep ? (
            <button type="button" className="link-btn bad" onClick={() => setDeleteStep(true)}>
              {t('edit.delete')}
            </button>
          ) : (
            <div className="box">
              <p>{t('edit.deleteConfirm', { name: existing.nickname })}</p>
              <button type="button" className="cta" onClick={handleDelete} disabled={submitting}>
                {t('edit.deleteYes')}
              </button>
              <button type="button" className="link-btn" onClick={() => setDeleteStep(false)}>
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
