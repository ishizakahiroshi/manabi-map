/**
 * 地域（リージョン）設計の器。
 *
 * Manabi Map は全国展開するが「全国を薄く 1 枚で覆う」のではなく、
 * 地方（リージョン）を 1 つずつ、その地方でベストな状態に仕上げて増やしていく。
 * 「関東」などの具体値をコードのあちこちにベタ書きせず、この Region 定義に集約する。
 * 検索（geo.ts）・地図初期表示・郵便番号解決はすべて ACTIVE_REGION を参照する。
 *
 * 設計思想の正典: docs/reference_regional-architecture.md
 */

/** リージョンに属する 1 都道府県の定義 */
export interface RegionPrefecture {
  /** 正式名称（「東京都」「群馬県」…）。住所文字列マッチと圏内判定に使う */
  name: string
  /** 郵便番号 上 3 桁の範囲（両端含む）。北海道のような非連続地域に対応する。 */
  postal3: Array<[number, number]>
  /** 郵便番号しか分からないときの暫定代表点（県の中心付近）。正確な地点は後で geocoder が上書きする */
  center: { lat: number; lng: number }
  /** 暫定表示ラベル（「東京都周辺」など） */
  label: string
}

/** 1 つの地方を表す設定（全国共通の「器」。中身を差し替えれば別地方に展開できる） */
export interface Region {
  /** 内部 ID */
  id: string
  labelJa: string
  labelEn: string
  /** 対象の都道府県 */
  prefectures: RegionPrefecture[]
  /** 地理範囲 bbox: [west, south, east, north]（経度・緯度） */
  bbox: [number, number, number, number]
  /** 地図の初期表示（このリージョンを開いたときの中心とズーム） */
  mapCenter: { lat: number; lng: number }
  mapZoom: number
}

/**
 * 東日本 20 都道県（北海道・東北・北陸・甲信越・関東）。
 * 北海道の郵便番号は 001〜009 と 040〜099 に分かれるため、郵便番号範囲は配列で持つ。
 * center は県庁所在地付近（郵便番号だけの暫定着地用。正確な地点は geocoder が引き直す）。
 */
export const EAST_JAPAN: Region = {
  id: 'east-japan',
  labelJa: '東日本 20 都道県',
  labelEn: 'Eastern Japan (20 prefectures)',
  prefectures: [
    { name: '北海道', postal3: [[0, 9], [40, 99]], center: { lat: 43.0642, lng: 141.3469 }, label: '北海道周辺' },
    { name: '青森県', postal3: [[30, 39]], center: { lat: 40.8244, lng: 140.7400 }, label: '青森県周辺' },
    { name: '岩手県', postal3: [[20, 29]], center: { lat: 39.7036, lng: 141.1527 }, label: '岩手県周辺' },
    { name: '宮城県', postal3: [[980, 989]], center: { lat: 38.2682, lng: 140.8694 }, label: '宮城県周辺' },
    { name: '秋田県', postal3: [[10, 19]], center: { lat: 39.7186, lng: 140.1024 }, label: '秋田県周辺' },
    { name: '山形県', postal3: [[990, 999]], center: { lat: 38.2404, lng: 140.3633 }, label: '山形県周辺' },
    { name: '福島県', postal3: [[960, 979]], center: { lat: 37.7608, lng: 140.4747 }, label: '福島県周辺' },
    { name: '新潟県', postal3: [[940, 959]], center: { lat: 37.9026, lng: 139.0232 }, label: '新潟県周辺' },
    { name: '富山県', postal3: [[930, 939]], center: { lat: 36.6953, lng: 137.2113 }, label: '富山県周辺' },
    { name: '石川県', postal3: [[920, 929]], center: { lat: 36.5947, lng: 136.6256 }, label: '石川県周辺' },
    { name: '福井県', postal3: [[910, 919]], center: { lat: 36.0652, lng: 136.2216 }, label: '福井県周辺' },
    { name: '山梨県', postal3: [[400, 409]], center: { lat: 35.6642, lng: 138.5684 }, label: '山梨県周辺' },
    { name: '長野県', postal3: [[380, 399]], center: { lat: 36.6513, lng: 138.1810 }, label: '長野県周辺' },
    { name: '東京都', postal3: [[100, 208]], center: { lat: 35.6895, lng: 139.6917 }, label: '東京都周辺' },
    { name: '神奈川県', postal3: [[210, 259]], center: { lat: 35.4478, lng: 139.6425 }, label: '神奈川県周辺' },
    { name: '千葉県', postal3: [[260, 299]], center: { lat: 35.6074, lng: 140.1065 }, label: '千葉県周辺' },
    { name: '茨城県', postal3: [[300, 319]], center: { lat: 36.3418, lng: 140.4468 }, label: '茨城県周辺' },
    { name: '栃木県', postal3: [[320, 329]], center: { lat: 36.5658, lng: 139.8836 }, label: '栃木県周辺' },
    { name: '埼玉県', postal3: [[330, 369]], center: { lat: 35.8617, lng: 139.6455 }, label: '埼玉県周辺' },
    { name: '群馬県', postal3: [[370, 379]], center: { lat: 36.3895, lng: 139.0634 }, label: '群馬県周辺' },
  ],
  // 西端 135.4 = 福井県嶺南（小浜・高浜）を含む / 南端 26.9 = 東京都島嶼部
  // （伊豆諸島・小笠原）を含む。136〜146E の低緯度帯はほぼ海域で、bbox に入る
  // 紀伊半島南岸などの圏外県は namesForeignPrefecture の県名判定で除外される。
  bbox: [135.4, 26.9, 146.0, 45.7],
  mapCenter: { lat: 40.4, lng: 140.4 },
  mapZoom: 5,
}

/** 後方互換用。既存の関東固有コードを壊さず、アクティブ地域だけを東日本へ切り替える。 */
export const KANTO: Region = EAST_JAPAN

/**
 * いまアクティブな地方。全国展開時はここを差し替える（将来は複数リージョン選択も想定）。
 * 現在は東日本 20 都道県をアクティブにして、そこをベストに仕上げる。
 */
export const ACTIVE_REGION: Region = EAST_JAPAN

/**
 * Nominatim の viewbox 文字列（"west,north,east,south" 順）。
 * bbox = [west, south, east, north] から並べ替える。
 */
export function regionViewbox(r: Region = ACTIVE_REGION): string {
  const [w, s, e, n] = r.bbox
  return `${w},${n},${e},${s}`
}

/** 郵便番号 上 3 桁（数値）が属する都道府県。範囲外（圏外）なら null */
export function prefectureForPostal3(n: number, r: Region = ACTIVE_REGION): RegionPrefecture | null {
  return r.prefectures.find((p) => p.postal3.some(([min, max]) => n >= min && n <= max)) ?? null
}

/** 住所・表示名テキストにリージョン内の都道府県名が含まれるか */
export function addressInRegion(text: string, r: Region = ACTIVE_REGION): boolean {
  return r.prefectures.some((p) => text.includes(p.name))
}

/** 緯度経度がリージョンの bbox 内か */
export function latLngInRegion(lat: number, lng: number, r: Region = ACTIVE_REGION): boolean {
  const [w, s, e, n] = r.bbox
  return lng >= w && lng <= e && lat >= s && lat <= n
}

/** 全 47 都道府県名（圏外判定用）。bbox の長方形は隣県の端をわずかに含むため、
 *  候補テキストが「リージョン外の都道府県名」を明示している場合は地理判定より優先して圏外にする。 */
export const ALL_PREFECTURES: readonly string[] = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]

/** テキストがリージョン外の都道府県名を明示的に含むか（例: 関東版で「静岡県」を含む） */
export function namesForeignPrefecture(text: string, r: Region = ACTIVE_REGION): boolean {
  const own = new Set(r.prefectures.map((p) => p.name))
  return ALL_PREFECTURES.some((p) => !own.has(p) && text.includes(p))
}
