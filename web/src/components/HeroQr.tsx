import { QRCodeSVG } from 'qrcode.react'
import { useI18n } from '../contexts/I18nContext'

const SITE_URL = 'https://manabi-map.app'

/**
 * PC 表示時にヒーロー右へ出す「スマホで続きを見る」QR。
 * 中央に icon.svg（オレンジのピン）を重ね、誤り訂正レベル H で読み取りを担保する。
 * スマホ幅では CSS（.hero-qr）で非表示にする。
 */
export function HeroQr() {
  const { t } = useI18n()
  return (
    <aside className="hero-qr" aria-label={t('home.qrAlt')}>
      <div className="hero-qr-card">
        <QRCodeSVG
          value={SITE_URL}
          size={104}
          level="H"
          bgColor="#fffdf8"
          fgColor="#241f1a"
          title={t('home.qrAlt')}
          imageSettings={{
            src: '/icon.svg',
            height: 26,
            width: 26,
            excavate: true,
          }}
        />
      </div>
      <p className="hero-qr-caption">{t('home.qrCaption')}</p>
    </aside>
  )
}
