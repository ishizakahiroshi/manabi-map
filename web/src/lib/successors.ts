// 前身校 id → 後継校の逆引き（「この高校の募集は◯◯に引き継がれています」）。
//
// React 側（SchoolDetailSheet）と Node ビルドスクリプト
// （scripts/gen-seo-pages.mjs / gen-schools-json.mjs が .ts のまま import する。
// Node 22.18+ の type stripping 前提・erasableSyntaxOnly）で共有される。
// 静的 HTML・学校単体 JSON・JS mount 後で後継校リンクが食い違わないよう、
// この 1 実装だけを使う。依存を持たない純関数だけを置くこと。

export interface SuccessorRef {
  id: string
  name: string
}

export interface SuccessorSourceSchool {
  id: string
  name: string
  predecessor_relationships?: ReadonlyArray<{ predecessor?: { id: string } | null }> | null
}

/**
 * 前身校 id → 後継校 [{ id, name }] の逆引きを作る。
 * 同一後継校が同じ前身校へ複数の関係行を持っていても 1 件に畳む。
 */
export function successorsByPredecessorId(
  schools: readonly SuccessorSourceSchool[],
): Map<string, SuccessorRef[]> {
  const map = new Map<string, SuccessorRef[]>()
  for (const school of schools) {
    for (const relationship of school.predecessor_relationships ?? []) {
      const predecessorId = relationship.predecessor?.id
      if (!predecessorId) continue
      const list = map.get(predecessorId) ?? []
      if (!list.some((entry) => entry.id === school.id)) {
        list.push({ id: school.id, name: school.name })
      }
      map.set(predecessorId, list)
    }
  }
  return map
}
