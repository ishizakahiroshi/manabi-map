import { useI18n } from '../contexts/I18nContext'
import { schoolReferenceStatus } from '../lib/saved-school-references'
import './SavedSchoolReference.css'

/** Display only: never resolves a saved ID against the private school source. */
export function SavedSchoolReference({ id, loading, error }: {
  id: string
  loading: boolean
  error: string | null
}) {
  const { t } = useI18n()
  return (
    <span className="saved-school-reference">
      <span>{t(`savedSchool.${schoolReferenceStatus(loading, error)}`)}</span>
      <span>{t('savedSchool.retained')}</span>
      <span>{t('savedSchool.id', { id })}</span>
    </span>
  )
}
