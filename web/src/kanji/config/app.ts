// アプリ設定値の集約（子 plan C10 N2・指示書 §3・native readiness 文書 §3）。
// URL・サービスの識別子をここ 1 か所にまとめ、将来ブランド名が決まる・配置が変わるときに
// 直す場所を減らす。画面・部品はここを import し、URL を直書きしない（子 plan「作業内容」2）。
//
// schoolUrl: 学校サイトはまだ manabi-map.app のまま。school.manabi-map.app への移行は別の作業
// （指示書 §13「今回やらないもの」）なので、いまつながる URL にしてある。移行が決まったら
// ここだけ直す。
//
// ブランドの文字列（「たねもじ」等）はここに置かない。言語パック（i18n/packs/*.json）と
// web/kanji/index.html・web/kanji/public/manifest.webmanifest にある（子 plan「作業内容」2）。
//
// Bundle ID・Android applicationId・Deep Link Scheme・App Store ID・Google Play ID は、
// 正式なサービス名が決まるまで決めない（入れない。native readiness 文書 §3・§11・§12「今は
// 決めない」）。
export const APP_CONFIG = {
  /** サービスを識別する短い key（将来 API・ログの分岐等で使う想定） */
  serviceKey: 'kanji',
  /** 漢字アプリ自身の公開 URL（まだ Cloudflare へは出していない。子 plan「概要」） */
  publicOrigin: 'https://kanji.manabi-map.app',
  /** 学校選びの Manabi Map（MoreDrawer.tsx・pages/WelcomePage.tsx の外部リンク先） */
  schoolUrl: 'https://manabi-map.app/',
} as const
