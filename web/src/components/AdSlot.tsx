interface AdSlotProps {
  category: string
  title: string
  description: string
  cta: string
  className?: string
}

/**
 * 塾アフィリ枠プレースホルダ（§7.5）。v0.1 ではリンク先未契約のため
 * ボタンは説明のみ表示する。ASP 契約後に href を差し込む。
 */
export function AdSlot({ category, title, description, cta, className }: AdSlotProps) {
  return (
    <div className={`ad-slot ${className ?? ''}`}>
      <span className="pr-tag">PR</span>
      <span className="ad-cat">{category}</span>
      <h4>{title}</h4>
      <p>{description}</p>
      <a
        className="go"
        href="#pr"
        onClick={(e) => e.preventDefault()}
        aria-disabled="true"
        title="広告リンクは準備中です"
      >
        {cta} →
      </a>
    </div>
  )
}
