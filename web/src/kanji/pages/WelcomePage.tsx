// はじめての画面（C8・子 plan「作業内容」2。C9・子 plan「作業内容」3 で「たねもじ」の文言に差し替え）。
// ヘッダーはページでは描かず、routing.ts の ROUTE_TABLE に登録済み（variant 'brand'。C6 の仕組み）。
// 見本の SCREENS.welcome を見た目の見本にしたが、LINE / Google でログイン・先生の入口・機能の一覧・
// 力だめしはこの C では出さない（子 plan「調査で確認した現在の実装」）。
//
// 「はじめる」は /profiles/new への Link にした（C7 の ProfileSheet「＋ 学習者を追加」と
// 同じ考え方。renderToString だけで行き先を確かめられるようにするため）。
//
// 子 plan「作業内容」1（はじめての画面は brand.withSubtitle を使う）と「作業内容」3（見出しの下に
// 副題 brand.subtitle を添える）が食い違うので、3 に従った（2026-09-24 C9 レビュー should 1）。
// ヘッダーの「たねもじ」（variant 'brand'。routing.ts の仕組み）と、この見出しと、その下の
// 「漢字学習」（brand.subtitle）で、指示書 §11「主要な初回接点では併記する」の趣旨を満たす。

import { Link } from 'react-router-dom'
import { APP_CONFIG } from '../config/app'
import { useI18n } from '../i18n/I18nProvider'
import { ROUTES } from '../routing'

export function WelcomePage() {
  const { t } = useI18n()
  return (
    <>
      <h1 className="catch">{t('wel.title')}</h1>
      <p className="catch-subtitle">{t('brand.subtitle')}</p>
      <p className="sub">{t('wel.body')}</p>
      <Link className="cta" to={ROUTES.profileNew}>
        {t('wel.start')}
      </Link>
      <p className="center">
        <a className="link-btn" href={APP_CONFIG.schoolUrl} target="_blank" rel="noopener">
          {t('wel.school')}
        </a>
      </p>
      {/* 親 plan D-1: はじめての画面に常に出す注記。C9 で 2 つ（notice.unofficial・notice.localOnly）
          を続けて出すようにした（子 plan「作業内容」2）。 */}
      <p className="notice">{t('notice.unofficial')}</p>
      <p className="notice">{t('notice.localOnly')}</p>
    </>
  )
}
