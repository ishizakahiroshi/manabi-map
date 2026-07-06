import type { School } from '../types/school'
import { GEN_LABEL, OWN_LABEL, band, botDev, topDev } from '../lib/format'
import { useI18n, type TFunction } from '../contexts/I18nContext'

function label(t: TFunction, prefix: string, key: string): string {
  return t(`${prefix}.${key}`)
}

/** Locale-aware display helpers. School names stay in Japanese per C10-C7 spec. */
export function useFormat() {
  const { t, locale } = useI18n()

  return {
    ownFull: (key: string) => label(t, 'labels.own', key),
    genFull: (key: string) => label(t, 'labels.gen', key),
    typeFull: (key: string) => label(t, 'labels.type', key),
    courseFull: (key: string) => label(t, 'labels.course', key),
    campusFull: (key: string) => label(t, 'labels.campus', key),

    courseTimeLabel: (s: School) => {
      const labels = s.course_times.map((c) => label(t, 'labels.course', c)).filter(Boolean)
      return labels.length ? labels.join('・') : t('common.infoPending')
    },

    enrollmentLabel: (s: School) => {
      if (s.total_students == null || s.enrollment_year == null) return t('common.infoPending')
      return t('labels.enrollment', {
        count: s.total_students.toLocaleString(),
        year: s.enrollment_year,
      })
    },

    genderRatioLabel: (s: School): string | null => {
      if (s.male_ratio == null) return null
      const source =
        s.enrollment_year != null
          ? t('labels.genderSourceSurvey', { year: s.enrollment_year })
          : t('labels.genderSourceOfficial')
      return t('labels.genderRatio', {
        male: s.male_ratio,
        female: 100 - s.male_ratio,
        source,
      })
    },

    extraBadge: (s: School) => {
      if (s.type === 'kosen') return t('labels.kosenBadge')
      if (s.is_integrated) return t('labels.integratedBadge')
      return ''
    },

    devLabel: (s: School) => {
      const top = topDev(s)
      const bot = botDev(s)
      if (top == null || bot == null) return t('common.dash')
      return top === bot ? `${top}` : `${bot}〜${top}`
    },

    displayName: (s: School) => {
      const recruiting = s.is_recruiting ? '' : t('labels.notRecruiting')
      const own = label(t, 'labels.own', s.ownership)
      const gen = label(t, 'labels.gen', s.gender_type)
      const code = `${own}${gen}`
      const dev = (() => {
        const top = topDev(s)
        const bot = botDev(s)
        if (top == null || bot == null) return t('common.dash')
        return top === bot ? `${top}` : `${bot}〜${top}`
      })()
      return `${recruiting}${s.name}（${code}：${dev}）${s.type === 'kosen' ? t('labels.kosenBadge') : s.is_integrated ? t('labels.integratedBadge') : ''}`
    },

    displayCode: (s: School) => {
      if (locale === 'ja') {
        return (OWN_LABEL[s.ownership] ?? '') + (GEN_LABEL[s.gender_type] ?? '')
      }
      const OWN_SHORT: Record<string, string> = {
        prefectural: 'P',
        municipal: 'M',
        national: 'N',
        private: 'Pr',
        union: 'U',
      }
      const GEN_SHORT: Record<string, string> = { coed: 'C', boys: 'B', girls: 'G' }
      return (OWN_SHORT[s.ownership] ?? '') + (GEN_SHORT[s.gender_type] ?? '')
    },

    band,
  }
}