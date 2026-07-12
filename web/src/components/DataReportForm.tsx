import { useState, type FormEvent } from 'react'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { MAINTENANCE_MODE } from '../lib/maintenance'
import { supabase } from '../lib/supabase'

export type DataReportField = 'capacity' | 'total_students' | 'male_ratio' | 'deviation' | 'other'

interface Props {
  schoolId: string
  departmentId?: string | null
  field: DataReportField
  targetLabel: string
}

const REPORT_RATE_KEY = 'manabi-map-data-report-rate'
const REPORT_RATE_WINDOW_MS = 10 * 60 * 1000
const REPORT_RATE_LIMIT = 5

function recentReportTimestamps(): number[] {
  try {
    const raw = localStorage.getItem(REPORT_RATE_KEY)
    if (!raw) return []
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values)) return []
    const cutoff = Date.now() - REPORT_RATE_WINDOW_MS
    return values.filter((value): value is number => typeof value === 'number' && value > cutoff)
  } catch {
    return []
  }
}

function rememberReport(): void {
  try {
    localStorage.setItem(REPORT_RATE_KEY, JSON.stringify([...recentReportTimestamps(), Date.now()]))
  } catch {
    // localStorage が使えない環境では DB 側の rate limit に委ねる。
  }
}

export function DataReportForm({ schoolId, departmentId = null, field, targetLabel }: Props) {
  const { session } = useAuth()
  const { setLoginOpen, toast } = useApp()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [proposedValue, setProposedValue] = useState('')
  const [source, setSource] = useState('')
  const [comment, setComment] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (MAINTENANCE_MODE) {
      toast(t('maintenance.toast'))
      return
    }
    if (!session) {
      toast(t('report.loginRequired'))
      setLoginOpen(true)
      return
    }
    // 人間向けには見えない入力欄。値が入っていたら送信せず静かに終了する。
    if (honeypot.trim()) {
      setExpanded(false)
      return
    }
    const value = proposedValue.trim()
    const sourceValue = source.trim()
    const commentValue = comment.trim()
    if (!value) {
      toast(t('report.valueRequired'))
      return
    }
    if (!sourceValue) {
      toast(t('report.sourceRequired'))
      return
    }
    if (recentReportTimestamps().length >= REPORT_RATE_LIMIT) {
      toast(t('report.rateLimited'))
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase.from('data_reports').insert({
        school_id: schoolId,
        department_id: departmentId,
        field,
        proposed_value: value,
        source: sourceValue,
        comment: commentValue || null,
        reporter_user_id: session.user.id,
      })
      if (error) throw error
      rememberReport()
      setProposedValue('')
      setSource('')
      setComment('')
      setExpanded(false)
      toast(t('report.submitDone'))
    } catch (error) {
      const code = (error as { code?: string }).code
      toast(code === 'P0001' ? t('report.rateLimited') : t('report.submitFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="data-report">
      <button
        type="button"
        className="data-report-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? t('report.close') : `＋ ${t('report.provide')}`}
      </button>
      {expanded && (
        <form className="data-report-form" onSubmit={(event) => void handleSubmit(event)}>
          <strong>{t('report.title')}</strong>
          <p className="data-report-target">{t('report.target', { target: targetLabel })}</p>
          <p className="data-report-fixed-note">{t('report.reviewNote')}</p>
          <label>
            {t('report.valueLabel')}
            <input
              type="text"
              value={proposedValue}
              maxLength={2000}
              onChange={(event) => setProposedValue(event.target.value)}
              placeholder={t('report.valuePlaceholder')}
              autoComplete="off"
            />
          </label>
          <label>
            {t('report.sourceLabel')}
            <input
              type="text"
              value={source}
              maxLength={2000}
              onChange={(event) => setSource(event.target.value)}
              placeholder={t('report.sourcePlaceholder')}
              autoComplete="off"
            />
          </label>
          <label>
            {t('report.commentLabel')}
            <textarea
              value={comment}
              maxLength={2000}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t('report.commentPlaceholder')}
            />
          </label>
          <input
            className="data-report-honeypot"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={honeypot}
            onChange={(event) => setHoneypot(event.target.value)}
          />
          <p className="data-report-caution">{t('report.caution')}</p>
          <button type="submit" className="data-report-submit" disabled={saving || MAINTENANCE_MODE}>
            {saving ? t('report.submitting') : t('report.submit')}
          </button>
        </form>
      )}
    </div>
  )
}
