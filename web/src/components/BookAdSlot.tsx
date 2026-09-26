import type { BookAd } from '../lib/bookAdCatalog'
import { isSafeBookCover } from '../lib/bookAdCatalog'
import { useI18n } from '../contexts/I18nContext'
import { trackEvent } from '../lib/analytics'

interface Props {
  ad: BookAd
  schoolId: string
  prefecture: string
}

/** 同じ本の購入先を左右に配置。URLは提供元の発行内容をそのまま使う。 */
export function BookAdSlot({ ad, schoolId, prefecture }: Props) {
  const { t } = useI18n()
  return (
    <div className="ad-slot book-ad" data-ad-slot-id={ad.id}>
      <span className="pr-tag">{t('common.adLabel')}</span>
      <span className="ad-cat">{t('bookAd.category')}</span>
      <h4>{ad.title}</h4>
      <p>{ad.publisher} · {t('bookAd.description', { prefecture })}</p>
      {isSafeBookCover(ad.coverHtml) && <figure className="book-ad-cover">
        <div
          className="book-ad-cover-art"
          onClick={(event) => {
            if (!(event.target instanceof Element) || !event.target.closest('a')) return
            trackEvent('ad_click', {
              ad_slot: `${ad.id}-rakuten`,
              placement: 'school-detail',
              school_id: schoolId,
              prefecture,
            })
          }}
        >
          {/* 楽天発行の128版を改変せず1つだけ出す。240版を併記すると非表示でも取得される。 */}
          <div className="book-ad-cover-mobile" dangerouslySetInnerHTML={{ __html: ad.coverHtml }} />
        </div>
        <figcaption>{t('bookAd.coverCaption')}</figcaption>
      </figure>}
      <div className="book-ad-stores">
        {ad.links.map(({ store, href }) => (
          <a
            key={store}
            className="book-ad-store"
            data-store={store}
            href={href}
            target="_blank"
            rel="noopener sponsored nofollow"
            aria-label={t('bookAd.linkLabel', { store: t(`bookAd.${store}`), title: ad.title })}
            onClick={() => trackEvent('ad_click', {
              ad_slot: `${ad.id}-${store}`,
              placement: 'school-detail',
              school_id: schoolId,
              prefecture,
            })}
          >
            <span className="book-ad-store-name">{t(`bookAd.${store}`)}</span>
            <span aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
      <p className="book-ad-disclosure">
        {t('bookAd.disclosure')} <a href="/legal/privacy#ads">{t('bookAd.aboutAds')}</a>
      </p>
    </div>
  )
}
