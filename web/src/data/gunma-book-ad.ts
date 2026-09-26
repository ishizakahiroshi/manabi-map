import type { School } from '../types/school'

/** 手動選定した試験掲載。提供されたURLを保持し、UTM等を付け足さない。 */
export const GUNMA_BOOK_AD = {
  id: 'gunma-public-exam-2027',
  title: '群馬県公立高校（2027年度用）6年間スーパー過去問',
  publisher: '声の教育社',
  // 楽天発行の128版を1つだけ載せる。240版を同時に置くと、非表示でも画像が両方取られる。
  // タグ・属性・画像サイズは改変しない。外部入力をこのHTML欄へ直接流し込まない。
  mobileCoverHtml: "<a href=\"https://hb.afl.rakuten.co.jp/ichiba/16aeabad.77964702.16aeabae.828f5f41/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fbook%2F18560613%2F&link_type=pict&ut=eyJwYWdlIjoiaXRlbSIsInR5cGUiOiJwaWN0Iiwic2l6ZSI6IjEyOHgxMjgiLCJuYW0iOjEsIm5hbXAiOiJyaWdodCIsImNvbSI6MSwiY29tcCI6ImRvd24iLCJwcmljZSI6MCwiYm9yIjoxLCJjb2wiOjEsImJidG4iOjEsInByb2QiOjAsImFtcCI6ZmFsc2V9\" target=\"_blank\" rel=\"nofollow sponsored noopener\" style=\"word-wrap:break-word;\"><img src=\"https://hbb.afl.rakuten.co.jp/hgb/16aeabad.77964702.16aeabae.828f5f41/?me_id=1213310&item_id=21896537&pc=https%3A%2F%2Fthumbnail.image.rakuten.co.jp%2F%400_mall%2Fbook%2Fcabinet%2F4696%2F9784799684696_1_2.jpg%3F_ex%3D128x128&s=128x128&t=pict\" border=\"0\" style=\"margin:2px\" alt=\"\" title=\"\"></a>",
  links: [
    { store: 'amazon', href: "https://www.amazon.co.jp/%E7%BE%A4%E9%A6%AC%E7%9C%8C%E5%85%AC%E7%AB%8B%E9%AB%98%E6%A0%A1-2027%E5%B9%B4%E5%BA%A6%E7%94%A8-6%E5%B9%B4%E9%96%93%E3%82%B9%E3%83%BC%E3%83%91%E3%83%BC%E9%81%8E%E5%8E%BB%E5%95%8F%EF%BC%88%E5%A3%B0%E6%95%99%E3%81%AE%E5%85%AC%E7%AB%8B%E9%AB%98%E6%A0%A1%E9%81%8E%E5%8E%BB%E5%95%8F%E3%82%B7%E3%83%AA%E3%83%BC%E3%82%BA-214%EF%BC%89-%E5%A3%B0%E3%81%AE%E6%95%99%E8%82%B2%E7%A4%BE/dp/4799684698?__mk_ja_JP=%E3%82%AB%E3%82%BF%E3%82%AB%E3%83%8A&crid=33SAN9INOH43X&dib=eyJ2IjoiMSJ9.6_pJ1uiZorRiVftVLSPr_7x8_8FpvKUkRBZrEv7p1Aa-cQxnfAIXScsAcyFvypY_PUsZfJAdU6kSuOfUmbzLkeYF0D-WI6fZTcK7Rv2CMyRwLxZnPzwwxl_6ueIiD7NyspcknwCxuYuVkz0C2iN7UNiwUXqrQbJw6TqS0c7HnadAaD9yQ5WhnhUyMWIJK4eznh8gjV7K2h0mmFpAh1MK29msAqNXNTHnnt9psTpRi6H-9LqWZmz2imJNsSsAj2RQSzR9azVGnqtn2KplsIZR7yqmkMYBgG3aqLvAbtziNIE.hoDxdGf-FC6hXu7mf2iYIF1i_ED3xkIUZyUurdM2E7A&dib_tag=se&keywords=%E7%BE%A4%E9%A6%AC%E7%9C%8C+%E5%85%AC%E7%AB%8B%E9%AB%98%E6%A0%A1+2027%E5%B9%B4%E5%BA%A6%E7%94%A8+6%E5%B9%B4%E9%96%93%E3%82%B9%E3%83%BC%E3%83%91%E3%83%BC%E9%81%8E%E5%8E%BB%E5%95%8F&qid=1790429842&sprefix=%E7%BE%A4%E9%A6%AC%E7%9C%8C%E5%85%AC%E7%AB%8B%E9%AB%98%E6%A0%A1+2027%E5%B9%B4%E5%BA%A6%E7%94%A8+6%E5%B9%B4%E9%96%93%E3%82%B9%E3%83%BC%E3%83%91%E3%83%BC%E9%81%8E%E5%8E%BB%E5%95%8F%2Caps%2C203&sr=8-1&linkCode=ll2&tag=ishizaka-22&linkId=19432f7a15043bbb1da559e90de8d12e&ref_=as_li_ss_tl" },
    { store: 'rakuten', href: "https://hb.afl.rakuten.co.jp/ichiba/16aeabad.77964702.16aeabae.828f5f41/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fbook%2F18560613%2F&link_type=hybrid_url&ut=eyJwYWdlIjoiaXRlbSIsInR5cGUiOiJoeWJyaWRfdXJsIiwic2l6ZSI6IjI0MHgyNDAiLCJuYW0iOjEsIm5hbXAiOiJyaWdodCIsImNvbSI6MSwiY29tcCI6ImRvd24iLCJwcmljZSI6MSwiYm9yIjoxLCJjb2wiOjEsImJidG4iOjEsInByb2QiOjAsImFtcCI6ZmFsc2V9" },
  ],
} as const

/** 群馬の公立高校で、高校入試がある学校だけ。開校予定・在校生のみ・閉校・募集終了・高校募集なしには出さない。 */
export function showsGunmaBookAd(
  school: Pick<School, 'prefecture' | 'type' | 'ownership'> &
    Partial<Pick<School, 'recruitment_status_code' | 'lifecycle_status_code'>>,
): boolean {
  if (
    school.lifecycle_status_code === 'planned' ||
    school.lifecycle_status_code === 'closing' ||
    school.lifecycle_status_code === 'closed'
  ) return false
  if (
    school.recruitment_status_code === 'no_external_high_school_intake' ||
    school.recruitment_status_code === 'stopped'
  ) return false
  return school.prefecture === '群馬県'
    && school.type === 'high_school'
    && (school.ownership === 'prefectural' || school.ownership === 'municipal' || school.ownership === 'union')
}

