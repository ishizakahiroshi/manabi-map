import { useNavigate, useParams } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'
import { useSchoolDetail } from '../hooks/useSchoolDetail'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'
import { NotFoundPage } from './NotFoundPage'

interface Props {
  userData: ReturnType<typeof useUserData>
}

/**
 * /school/:id — 学校詳細ページ（直リンク着地）。
 * 初回直リンクはプリレンダー HTML（scripts/gen-seo-pages.mjs の renderSchoolPage）が出るため、
 * ここは mount 後の描画を担当する（白紙防止）。
 *
 * 初期描画は学校単体 JSON（/school-data/<id>.json・数 KB）で完結させ、
 * Leaflet も全件 JSON も読まない（plan_seo-growth-strategy_c7 C1 / C3）。
 * 地図は「地図で見る」導線（/map?school=<id>）から遅延読み込みされる。
 */
export function SchoolDetailPage({ userData }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useI18n()
  const { school, extras, loading, notFound, error } = useSchoolDetail(id ?? null)

  if (notFound) return <NotFoundPage />

  return (
    <div className="screen">
      {school == null && (
        <main id="main-content" className="content" tabIndex={-1} aria-busy={loading}>
          {loading && <p className="mini-hint">{t('common.loading')}</p>}
          {!loading && error && (
            <p className="mini-hint bad" role="alert">
              {error}
            </p>
          )}
        </main>
      )}
      {school && (
        <SchoolDetailSheet
          school={school}
          extras={extras}
          standalone
          onClose={() => navigate('/map', { replace: true })}
          userData={userData}
        />
      )}
    </div>
  )
}
