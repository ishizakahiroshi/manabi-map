import assert from 'node:assert/strict'
import test from 'node:test'

import { DESCRIPTION_DEPT_LIMIT, cityBreakdownSentence, cityPageDescription } from './city-breakdown.mjs'
import { DEPT_GROUP_CODES } from './dept-groups-shared.mjs'

const C = DEPT_GROUP_CODES
/** CompactPrefSchool の最小形。ct 未指定は生成側と同じく全日制。 */
const s = ({ o = 'prefectural', ct = ['fulltime'], dg, ig } = {}) => ({
  o,
  ct,
  ...(dg ? { dg } : {}),
  ...(ig ? { ig: true } : {}),
})
const many = (n, props) => Array.from({ length: n }, () => s(props))

test('設置区分は公立 → 私立 → 国立 の固定順（件数順にしない）', () => {
  // 宇都宮市の形: 私立のほうが多いが、並びは公立が先。
  const entries = [...many(10, { dg: [C.general] }), ...many(13, { o: 'private', dg: [C.general] })]
  assert.match(cityBreakdownSentence(entries), /^公立 10 校・私立 13 校。/)
})

test('公立には prefectural / municipal / union をまとめる', () => {
  const entries = [
    s({ o: 'prefectural', dg: [C.general] }),
    s({ o: 'municipal', dg: [C.general] }),
    s({ o: 'union', dg: [C.general] }),
  ]
  assert.match(cityBreakdownSentence(entries), /^公立 3 校。/)
})

test('該当 0 件の設置区分は並べない', () => {
  const text = cityBreakdownSentence(many(3, { dg: [C.general] }))
  assert.match(text, /^公立 3 校。/)
  assert.doesNotMatch(text, /私立/)
  assert.doesNotMatch(text, /国立/)
})

test('学科は件数の多い順で、上限を超えたら「ほか」で閉じる', () => {
  const entries = [
    ...many(5, { dg: [C.general] }),
    ...many(4, { dg: [C.commercial] }),
    ...many(3, { dg: [C.industrial] }),
    ...many(2, { dg: [C.informatics] }),
    ...many(1, { dg: [C.comprehensive] }),
  ]
  const text = cityBreakdownSentence(entries)
  assert.match(text, /学科は普通科 5 校・商業 4 校・工業 3 校・情報 2 校 ほか。/)
  assert.doesNotMatch(text, /総合学科/, `上限 ${DESCRIPTION_DEPT_LIMIT} を超えた系統は名前を出さない`)
})

test('学科が上限ちょうどなら「ほか」を付けない', () => {
  const entries = [
    ...many(4, { dg: [C.general] }),
    ...many(3, { dg: [C.commercial] }),
    ...many(2, { dg: [C.industrial] }),
    ...many(1, { dg: [C.informatics] }),
  ]
  assert.match(cityBreakdownSentence(entries), /学科は普通科 4 校・商業 3 校・工業 2 校・情報 1 校。/)
})

test('1 校が複数系統を持つと、学科の合計は校数を超える', () => {
  const entries = [s({ dg: [C.general, C.commercial, C.industrial] })]
  const text = cityBreakdownSentence(entries)
  assert.match(text, /公立 1 校。/)
  // 同数のときは DEPT_GROUP_ORDER（MapPage と同じ想起順）で決める。工業が商業より先。
  assert.match(text, /学科は普通科 1 校・工業 1 校・商業 1 校。/)
})

test('神戸市の形: 学科がほぼ無い一覧では学科の節ごと出さない', () => {
  const entries = [
    ...many(3, { dg: [C.commercial] }),
    ...many(31, {}),
    ...many(26, { o: 'private' }),
    s({ o: 'national' }),
  ]
  const text = cityBreakdownSentence(entries)
  assert.match(text, /^公立 34 校・私立 26 校・国立 1 校。$/)
  assert.doesNotMatch(text, /学科/)
})

test('宇都宮市の形: 通信制のみの学校は学科ガードの分母から外れる', () => {
  const entries = [
    ...many(10, { dg: [C.general] }),
    ...many(5, { o: 'private', dg: [C.commercial] }),
    ...many(8, { o: 'private', ct: ['correspondence'] }),
  ]
  const text = cityBreakdownSentence(entries)
  assert.match(text, /^公立 10 校・私立 13 校。/)
  assert.match(text, /学科は普通科 10 校・商業 5 校。/, '通信制を分母に入れると 65% で伏せられてしまう')
})

test('中高一貫は 1 校以上のときだけ末尾に付く', () => {
  const withIntegrated = [...many(2, { dg: [C.general] }), s({ dg: [C.general], ig: true })]
  assert.match(cityBreakdownSentence(withIntegrated), /中高一貫 1 校。$/)
  assert.doesNotMatch(cityBreakdownSentence(many(3, { dg: [C.general] })), /中高一貫/)
})

/**
 * 日本語の検索結果は概ね 120 字前後で切られる。実データ 1,265 ページの実測最大は 109 字
 * （2026-08-25・本 skill の実装で計測）。上限までの余白 11 字を将来の文言変更のために残す。
 *
 * ここが落ちたら、締めの文を伸ばしたか学科の上限を上げた合図。**内訳のほうが切られる**ので、
 * 数字を削るのではなく締めの文を短くして直す。
 */
const DESCRIPTION_MAX_CHARS = 120

test('description は前置きと締めで挟み、全ページで 120 字に収まる', () => {
  // 実測最長（秋田市 109 字）より重い形。設置区分 3 種・学科 5 系統・中高一貫つき。
  const entries = [
    ...many(36, { dg: [C.general] }),
    ...many(20, { o: 'private', dg: [C.general, C.commercial] }),
    ...many(8, { o: 'private', dg: [C.industrial, C.informatics, C.home_welfare_nursing] }),
    s({ o: 'national', dg: [C.general], ig: true }),
  ]
  const text = cityPageDescription('神奈川県', '足柄上郡山北町', entries)
  assert.match(text, /^神奈川県足柄上郡山北町にある高校 65 校の一覧。/)
  assert.match(text, /地図で場所を確認できます。$/)
  assert.ok(
    text.length <= DESCRIPTION_MAX_CHARS,
    `description が長すぎる: ${text.length} 字（上限 ${DESCRIPTION_MAX_CHARS}）`,
  )
})

test('空の一覧では内訳を作らない（前置きと締めだけ残す）', () => {
  assert.equal(cityBreakdownSentence([]), '')
  assert.equal(
    cityPageDescription('合成県', '合成市', []),
    '合成県合成市にある高校 0 校の一覧。地図で場所を確認できます。',
  )
})
