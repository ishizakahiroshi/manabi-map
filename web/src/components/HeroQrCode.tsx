import { QRCodeSVG } from 'qrcode.react'
import site from '../../data/site.json'

/**
 * ヒーローの QR 本体。qrcode.react ごと初期バンドルから外すためにファイルを分けている
 * （plan_data-usage-audit.md C4）。読み込み中の枠は index.css の .hero-qr-slot が
 * 同じ 104px 角で確保しているので、この値を変えるときは CSS も合わせる。
 */
const HERO_QR_SIZE = 104

// 住所の正本は web/data/site.json（ここに直書きしない）。
const SITE_URL = site.origin

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
