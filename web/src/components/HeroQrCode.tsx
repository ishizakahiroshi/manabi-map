import { QRCodeSVG } from 'qrcode.react'

/**
 * ヒーローの QR 本体。qrcode.react ごと初期バンドルから外すためにファイルを分けている
 * （plan_data-usage-audit.md C4）。読み込み中の枠は index.css の .hero-qr-slot が
 * 同じ 104px 角で確保しているので、この値を変えるときは CSS も合わせる。
 */
const HERO_QR_SIZE = 104

const SITE_URL = 'https://manabi-map.app'

export function HeroQrCode({ title }: { title: string }) {
  return (
    <QRCodeSVG
      value={SITE_URL}
      size={HERO_QR_SIZE}
      level="H"
      bgColor="#fffdf8"
      fgColor="#241f1a"
      title={title}
      imageSettings={{
        src: '/icon.svg',
        height: 26,
        width: 26,
        excavate: true,
      }}
    />
  )
}
