import { supabase } from './supabase'

/**
 * C9: KPI イベントログ（クライアント計装）。
 *
 * 設計方針（plan_v0.2.0-release_c10_app-features.md §C9 / migration
 * 202607070302_v0.2.0_kpi_events.sql）:
 *
 * - **PII 絶対禁止を型で強制する**。イベントごとに「載せてよい props キー」を
 *   下の EventPropsMap で固定 union にしており、住所文字列・氏名・LINE 表示名・
 *   自宅座標のような PII キーは *そもそも型に存在しない* ため代入できない
 *   （リテラル呼び出しでは余剰プロパティチェックでコンパイルエラーになる）。
 * - session_id は localStorage 発行の UUID（cookie 不使用・クッキーレス）。
 * - INSERT は fire-and-forget。失敗（オフライン / RLS 拒否 / migration 未適用中の
 *   404・403）はすべて握りつぶし、UX には一切影響させない。
 * - user_id は現在のセッションから取得して載せる（uuid のみ・PII ではない）。
 *   RLS の with_check（user_id is null or = auth.uid()）を満たすため、他人の
 *   user_id を詐称することは構造上できない。
 * - school_id は events テーブルのトップレベル列へ、その他は props(jsonb) へ入れる。
 */

/** localStorage の session_id キー（cookie は使わない） */
const SESSION_STORAGE_KEY = 'mm_session_id'

/**
 * 計測対象イベントと、そのイベントで載せてよい props のホワイトリスト。
 * ここに無いキー（住所・氏名・displayName・lat/lng 等の PII）は型レベルで載らない。
 */
interface EventPropsMap {
  /** 住所・現在地・郵便番号・デモから地図へ遷移した「検索実行」 */
  search: { prefecture?: string; result_count?: number; source?: string }
  /** お気に入り追加（削除は記録しない） */
  favorite_add: { school_id?: string; prefecture?: string }
  /** 学校メモの保存 */
  memo_save: { school_id?: string; prefecture?: string }
  /** 学校詳細シートの開封 */
  detail_open: { school_id?: string; prefecture?: string }
  /** 比較表の表示（2 校以上そろった時） */
  compare_view: { count?: number }
  /** 広告カードのクリック */
  ad_click: { ad_slot?: string; placement?: string; prefecture?: string; school_id?: string }
}

export type AnalyticsEventType = keyof EventPropsMap

/** イベントが school_id をトップレベル列へ持てるか（共通抽出用） */
type WithSchoolId = { school_id?: string }

/**
 * KPI イベントを 1 件記録する（fire-and-forget）。
 *
 * 呼び出し側は await しない。ネットワーク・RLS・migration 未適用に関わらず
 * 例外を投げず・UI を止めない。
 */
export function trackEvent<T extends AnalyticsEventType>(
  type: T,
  props: EventPropsMap[T] = {} as EventPropsMap[T],
): void {
  // 意図的に await しない。失敗は sendEvent 内で握りつぶす。
  void sendEvent(type, props)
}

async function sendEvent<T extends AnalyticsEventType>(type: T, props: EventPropsMap[T]): Promise<void> {
  try {
    // オフライン時は捨てる（キューに積んで後送りはしない）
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return

    const { data } = await supabase.auth.getSession()
    const userId = data.session?.user.id ?? null

    // school_id はトップレベル列へ、それ以外を props(jsonb) へ振り分ける
    const { school_id, ...rest } = props as WithSchoolId & Record<string, unknown>

    // 返り値の error は敢えて見ない（migration 未適用中は 404/403 になるが UX 非影響）
    await supabase.from('events').insert({
      event_type: type,
      user_id: userId,
      school_id: school_id ?? null,
      props: rest,
      session_id: getSessionId(),
    })
  } catch {
    // 何が起きても握りつぶす（計測は UX より常に劣後する）
  }
}

/** localStorage に永続する匿名 session_id を取得（無ければ発行）。cookie は使わない。 */
function getSessionId(): string {
  try {
    let id = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!id) {
      id = createId()
      localStorage.setItem(SESSION_STORAGE_KEY, id)
    }
    return id
  } catch {
    // localStorage 不可（プライベートブラウズ等）ではセッション横断を諦める
    return 'no-storage'
  }
}

/** UUID（events.session_id の 64 文字制約に十分収まる 36 文字） */
function createId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch {
    // fall through
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
