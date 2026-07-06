-- =====================================================================
-- v0.2.0: estimate_method rename — v1_gunma_2026 -> v1h_gunma_2026
--
-- 背景: 識別子 v1_gunma_2026 がドキュメント間で「式推計」(archive の
-- plan_data-acquisition-strategy §3.2) と「人手主観推計」の両方を指す
-- provenance 混同があった。実態確認 (2026-07-06) の結果、投入済み 138 件は
-- すべて人手主観推計（seed SQL の note 全件が定性的根拠・式計算の痕跡なし）。
-- 「1 識別子 = 1 手法」の命名規則に合わせ、既存レコードを人手系 v1h_* へ改名する。
--   - v1h_<pref>_<year>: 人手主観推計（新規投入では原則使わない）
--   - v1f_<pref>_<year>: 式推計（scripts/estimate/ の出力・v0.2 以降の標準）
--   - 接尾辞なし v1_<pref>_<year> は廃止
-- 命名規則の正典: docs/local/reference_school-data-collection-playbook.md
--
-- 影響: フロントエンドは estimate_method を参照していない（value / is_active のみ）
-- ため表示への影響なし。
--
-- rollback（適用を取り消す場合）:
--   update school_deviation_values
--     set estimate_method = 'v1_gunma_2026'
--     where estimate_method = 'v1h_gunma_2026';
-- =====================================================================

begin;

update school_deviation_values
  set estimate_method = 'v1h_gunma_2026'
  where estimate_method = 'v1_gunma_2026';

-- 改名漏れが無いことの検証（旧識別子が残っていたら失敗させる）
do $$
declare
  remaining integer;
begin
  select count(*) into remaining
    from school_deviation_values
    where estimate_method = 'v1_gunma_2026';
  if remaining > 0 then
    raise exception 'estimate_method rename incomplete: % rows still v1_gunma_2026', remaining;
  end if;
end $$;

commit;
