import { useEffect, useState, type ComponentType } from 'react'
import { useI18n } from '../contexts/I18nContext'

/**
 * PC 表示時にヒーロー右へ出す「スマホで続きを見る」QR。
 * 中央に icon.svg（オレンジのピン）を重ね、誤り訂正レベル H で読み取りを担保する。
 * スマホ幅では CSS（.hero-qr）で非表示にする。
 *
 * QR の描画本体（qrcode.react・gzip 約 8KB）は **mount 後に動的 import** する
 * （plan_data-usage-audit.md C4）。トップ以外の全ページ（県・市区町村・学校詳細）も
 * 同じ初期バンドルを読むため、据え置くと QR を一度も見ない利用者まで毎回払うことになる。
 * スマホ幅では CSS で非表示なので、主な利用者（中高生・モバイル）は 1 度も使わない。
 *
 * **React.lazy + Suspense ではなく useEffect + useState で読む。**
 * トップページはビルド時プリレンダー対象で、main.tsx が hydrateRoot で引き継ぐ。
 * hydration 中に lazy が未解決だと React は Suspense 境界のサーバー HTML を捨てるため、
 * プリレンダーした内容が一瞬消える（plan_ssr-hydration.md が潰した事故）。
 * この書き方なら初回 render は SSR と同じ「枠だけ」で一致し、QR は mount 後に差し込まれる。
 * 枠（.hero-qr-slot）は QR と同じ 104px 角を確保してあるので、差し込みで位置はずれない。
 */
export function HeroQr() {
  const { t } = useI18n()
  const [QrCode, setQrCode] = useState<ComponentType<{ title: string }> | null>(null)

  useEffect(() => {
    let alive = true
    import('./HeroQrCode')
      .then((module) => {
        if (alive) setQrCode(() => module.HeroQrCode)
      })
      .catch(() => {
        /* 取得できなければ枠のまま。QR は装飾で、無くても導線は失われない */
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <aside className="hero-qr" aria-label={t('home.qrAlt')}>
      <div className="hero-qr-card">
        <div className="hero-qr-slot">{QrCode ? <QrCode title={t('home.qrAlt')} /> : null}</div>
      </div>
      <p className="hero-qr-caption">{t('home.qrCaption')}</p>
    </aside>
  )
}
