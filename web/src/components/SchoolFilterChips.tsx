import { useI18n } from '../contexts/I18nContext'
import type { SchoolChip } from '../hooks/useSchoolChips'

interface Props {
  chips: SchoolChip[]
  active: boolean
  /** 学科チップを出しているか。注記の表示条件（useSchoolChips.showsDept と対）。 */
  showsDept?: boolean
  /** 絞り込み前の件数。 */
  total: number
  /** 絞り込み後の件数。 */
  shown: number
  onClear: () => void
}

/**
 * 一覧の内訳チップ（公立/私立/国立・課程・共学別学・学科系統・中高一貫）。
 * 県ページと市区町村ページで同じ見た目・同じ文言を使う（useSchoolChips と対）。
 */
export function SchoolFilterChips({ chips, active, showsDept, total, shown, onClear }: Props) {
  const { t } = useI18n()
  return (
    <>
      <div className="chip-row" role="group" aria-label={t('prefPage.chipsLabel')}>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`chip ${c.on ? 'on' : ''}`}
            aria-pressed={c.on}
            onClick={c.toggle}
          >
            {c.label} {c.n}
          </button>
        ))}
      </div>
      {showsDept && <p className="mini-hint soft">{t('prefPage.chipsDeptNote')}</p>}
      {active && (
        <div className="mini-hint" aria-live="polite">
          {t('prefPage.filterShowing', { total, shown })}{' '}
          <button type="button" className="chip" onClick={onClear}>
            {t('prefPage.filterClear')}
          </button>
        </div>
      )}
    </>
  )
}
