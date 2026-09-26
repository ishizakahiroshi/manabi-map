import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { GUNMA_BOOK_AD } from '../data/gunma-book-ad'
import { I18nProvider } from '../contexts/I18nContext'
import { BookAdSlot } from './BookAdSlot'

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }))

describe('過去問の購入先', () => {
  const html = () => renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(BookAdSlot, { schoolId: 'synthetic-school', prefecture: '群馬県' })))

  it('同じ本の購入先をAmazon、楽天の順に表示し、広告と紹介料を明示する', () => {
    const output = html()
    expect(output.indexOf('data-store="amazon"')).toBeLessThan(output.indexOf('data-store="rakuten"'))
    expect(output).toContain(GUNMA_BOOK_AD.title)
    expect(output).toContain('広告（PR）')
    expect(output).toContain('紹介料')
    expect(output).toContain('/legal/privacy#ads')
    expect(output).toContain(GUNMA_BOOK_AD.mobileCoverHtml)
    expect(output.match(/<img\b/g)).toHaveLength(1)
    expect(output).not.toContain('s=240x240')
    expect(output).toContain('表紙画像のリンク先：楽天ブックス')
    expect(output).not.toContain('価格：')
  })

  it('提供URLへUTM等を足さず、新規タブのスポンサーリンクとして出力する', () => {
    const output = html()
    const links = [...output.matchAll(/<a\s[^>]*data-store="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)]
    expect(links).toHaveLength(2)
    for (const [i, link] of links.entries()) {
      expect(link[1]).toBe(GUNMA_BOOK_AD.links[i].store)
      expect(link[2].replaceAll('&amp;', '&')).toBe(GUNMA_BOOK_AD.links[i].href)
      expect(link[0]).toContain('target="_blank"')
      expect(link[0]).toContain('rel="noopener sponsored nofollow"')
      expect(link[0]).toContain('新しいタブで開きます')
    }
  })
})
