import type { AdSlotItem } from '../data/ad-slots'
import { AD_CAMPAIGN_V014, withUtm } from '../lib/utm'

interface AdSlotProps {
  slot: AdSlotItem
  context?: {
    schoolId?: string
    prefecture?: string
  }
  /** カテゴリ横の副見出し（省略時はカテゴリ名の日本語表記） */
  categoryLabel?: string
  className?: string
}

const CATEGORY_JA: Record<AdSlotItem['category'], string> = {
  juku: '学習塾・個別指導',
  school: '学校広告',
  tsuushin_kyouiku: '通信教育',
  moshi: '模試',
}

/**
 * 塾アフィリ枠のカード（§7.5 / CLAUDE.md「広告ポリシー Non-negotiable」）。
 *
 * - 常に「PR」バッジを目立たせて広告と明示する（景表法・プラットフォーム透明化）
 * - CTA クリックは新規タブで開き、URL に UTM を自動付与
 * - 案件データは data/ad-slots.ts 側で管理し、本コンポーネントは表示のみ
 */
export function AdSlot({ slot, context, categoryLabel, className }: AdSlotProps) {
  const href = withUtm(slot.baseUrl, {
    campaign: AD_CAMPAIGN_V014,
    medium: slot.placement,
    content: context?.schoolId ? `school-${context.schoolId}` : slot.id,
  })

  return (
    <div className={`ad-slot ${className ?? ''}`} data-ad-slot-id={slot.id}>
      <span className="pr-tag">{slot.label || 'PR'}</span>
      <span className="ad-cat">{categoryLabel ?? CATEGORY_JA[slot.category]}</span>
      <h4>{slot.title}</h4>
      <p>{slot.description}</p>
      <a
        className="go"
        href={href}
        target="_blank"
        rel="noopener noreferrer sponsored nofollow"
        title="広告リンク（新しいタブで開きます）"
      >
        {slot.ctaText} →
      </a>
    </div>
  )
}
