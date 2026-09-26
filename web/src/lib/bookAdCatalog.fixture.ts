import type { BookAd } from './bookAdCatalog'

/** Synthetic product and identifiers, never a real affiliate campaign. */
export const syntheticBookAd: BookAd = {
  id: 'synthetic-public-exam', prefectureCode: '10', title: '合成県立高校 過去問集',
  publisher: '合成教材出版', examYear: 2027, enabled: true,
  links: [
    { store: 'amazon', href: 'https://www.amazon.co.jp/dp/SYNTHETIC0?tag=synthetic-22' },
    { store: 'rakuten', href: 'https://hb.afl.rakuten.co.jp/ichiba/synthetic/?pc=https%3A%2F%2Fexample.com%2Fsynthetic' },
  ],
  coverHtml: '<a href="https://hb.afl.rakuten.co.jp/ichiba/synthetic/" target="_blank" rel="nofollow noopener noreferrer"><img src="https://hbb.afl.rakuten.co.jp/synthetic/?pc=https%3A%2F%2Fthumbnail.image.rakuten.co.jp%2Fsynthetic.jpg&s=128x128&t=pict" border="0" style="margin:2px" alt="" title=""></a>',
}
