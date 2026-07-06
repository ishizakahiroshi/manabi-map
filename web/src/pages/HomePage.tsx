import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { parsePostal, searchNominatim, type GeocodeCandidate } from '../lib/geo'
import type { HomeLocation } from '../types/school'
import { AdSlot } from './../components/AdSlot'
import { slotsForPlacement } from '../data/ad-slots'

const DEMO_HOMES: Record<string, HomeLocation & { fill: string }> = {
  前橋市: { label: '前橋市 大手町', lat: 36.3907, lng: 139.0604, fill: '群馬県前橋市大手町' },
  高崎市: { label: '高崎市 高松町', lat: 36.322, lng: 139.0033, fill: '群馬県高崎市高松町' },
}

type Hint = { text: string; tone: 'accent' | 'ok' | 'bad' | 'soft' }

export function HomePage() {
  const navigate = useNavigate()
  const { setHome, toast, setLoginOpen } = useApp()
  const [q, setQ] = useState('')
  const [hint, setHint] = useState<Hint | null>(null)
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [selected, setSelected] = useState<(HomeLocation & { source: string }) | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastQuery = useRef('')

  const onQueryInput = (v: string) => {
    setQ(v)
    setSelected(null)
    setSearchError(false)
    if (timer.current) clearTimeout(timer.current)
    if (!v.trim()) {
      setHint(null)
      setCandidates(null)
      return
    }
    const local = parsePostal(v.trim())
    if (local) {
      setHint({ text: `✓ ${local.label}（郵便番号）`, tone: 'ok' })
      setSelected({ label: `〒${v.replace(/[^0-9-]/g, '')} ${local.label}`, lat: local.lat, lng: local.lng, source: 'postal' })
    } else {
      setHint({ text: '検索中…（住所・施設名・郵便番号どれでも）', tone: 'soft' })
    }
    // Nominatim Usage Policy 準拠のため 400ms デバウンス（実質 1 req/sec 以下）
    timer.current = setTimeout(() => void runSearch(v.trim(), !!local), 400)
  }

  const runSearch = async (query: string, hasPostal: boolean) => {
    if (query === lastQuery.current) return
    lastQuery.current = query
    setSearching(true)
    try {
      const items = await searchNominatim(query)
      setCandidates(items)
      setSearchError(false)
      if (items.length > 0 && !hasPostal) {
        pick(items[0])
      }
    } catch {
      setCandidates(null)
      setSearchError(true)
    } finally {
      setSearching(false)
    }
  }

  const pick = (c: GeocodeCandidate) => {
    setSelected({ label: c.label, lat: c.lat, lng: c.lng, source: 'nominatim' })
    setHint({ text: `✓ ${c.label} を地図の中心にします`, tone: 'ok' })
  }

  const clearQuery = () => {
    setQ('')
    setHint(null)
    setCandidates(null)
    setSelected(null)
    setSearchError(false)
    // リセットしないと同一クエリの再入力時に runSearch が早期 return し
    // 「検索中…」表示のまま候補が出なくなる
    lastQuery.current = ''
  }

  const useGeolocation = () => {
    if (!navigator.geolocation) {
      setHint({ text: 'この端末では現在地取得に対応していません', tone: 'bad' })
      return
    }
    setHint({ text: '現在地を取得中…（許可のダイアログが出たら「許可」）', tone: 'accent' })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        setSelected({ label: '現在地', lat, lng, source: 'geo' })
        setHint({ text: `✓ 現在地を取得しました（${lat.toFixed(3)}, ${lng.toFixed(3)}）`, tone: 'ok' })
        setCandidates(null)
        toast('現在地を取得しました')
      },
      (err) => {
        const msg =
          err.code === 1
            ? '位置情報の許可が必要です（ブラウザ設定を確認）'
            : err.code === 2
              ? '位置情報が取れませんでした'
              : err.code === 3
                ? '位置情報の取得がタイムアウトしました'
                : '位置情報エラー'
        setHint({ text: msg, tone: 'bad' })
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    )
  }

  const goToMap = () => {
    if (selected) {
      setHome({ label: selected.label, lat: selected.lat, lng: selected.lng })
      navigate('/map')
      return
    }
    const p = parsePostal(q.trim())
    if (p) {
      setHome(p)
      navigate('/map')
      return
    }
    if (!q.trim()) {
      toast('住所・郵便番号・お店の名前を入れてください')
      return
    }
    toast('検索候補から場所を選んでください')
  }

  const loadDemo = (key: keyof typeof DEMO_HOMES) => {
    const d = DEMO_HOMES[key]
    setHome({ label: d.label, lat: d.lat, lng: d.lng })
    setQ(d.fill)
    setCandidates(null)
    setSelected(null)
    navigate('/map')
  }

  return (
    <div className="content home-content">
      <h1 className="catch">
        親子で使う、
        <br />
        <span className="accent">学校選び</span>の地図ノート。
      </h1>
      <p className="sub">
        住所を入れると、通える高校が地図に表示されます。
        <br />
        気になる学校を保存して、家族でメモを残せます。
      </p>

      <label htmlFor="q" className="form-label">
        住所・郵便番号・駅名・お店の名前でOK
      </label>
      <div className="q-wrap">
        <input
          id="q"
          className="input"
          autoComplete="off"
          placeholder="例: 群馬県前橋市大手町 / 371-0026 / 前橋駅"
          value={q}
          onChange={(e) => onQueryInput(e.target.value)}
        />
        <button className="q-clear" onClick={clearQuery} title="クリア" aria-label="クリア">
          ×
        </button>
      </div>
      {hint && <div className={`mini-hint ${hint.tone === 'accent' ? '' : hint.tone}`}>{hint.text}</div>}
      <div className="q-results">
        {searching && <div className="spinner">場所を検索中…</div>}
        {searchError && (
          <div className="nores error">
            場所検索に失敗しました（オフライン or 接続制限の可能性）。住所テキストで再入力してください。
          </div>
        )}
        {!searching && !searchError && candidates?.length === 0 && (
          <div className="nores">該当なし。住所・駅・施設名で別の言い方を試してみてください。</div>
        )}
        {!searching &&
          candidates?.map((c, i) => (
            <button
              key={i}
              className={`cand ${selected?.label === c.label ? 'on' : ''}`}
              onClick={() => pick(c)}
            >
              <span className="cand-icon">{c.icon}</span>
              <span className="cand-body">
                <b>{c.label}</b>
                <span className="cand-sub">{c.sub}</span>
              </span>
            </button>
          ))}
      </div>

      <button className="cta secondary geo" onClick={useGeolocation}>
        <span className="geo-icon">📍</span> 現在地から取得する
      </button>

      <button className="cta" onClick={goToMap}>
        地図を見る
      </button>

      <div className="divider">または</div>
      <button className="cta secondary" onClick={() => toast('学校名検索は v0.2 で対応予定です')}>
        🔍 学校名で探す
      </button>

      <div className="divider">デモを試す（ログイン不要）</div>
      <div className="demo-links">
        <button onClick={() => loadDemo('前橋市')}>
          <span>▸ 群馬県 前橋市</span>
          <small>県庁所在地</small>
        </button>
        <button onClick={() => loadDemo('高崎市')}>
          <span>▸ 群馬県 高崎市</span>
          <small>県内最大都市</small>
        </button>
      </div>

      <ul className="feature-list">
        <li>高校名と偏差値を地図で見る</li>
        <li>気になる学校を保存する</li>
        <li>文化祭・部活・通学メモを残す</li>
      </ul>

      <button className="login-btn" onClick={() => setLoginOpen(true)}>
        ログイン / 新規登録
      </button>

      {slotsForPlacement('home').map((s) => (
        <AdSlot key={s.id} slot={s} categoryLabel="近くの塾を探す" />
      ))}
    </div>
  )
}
