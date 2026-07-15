# Admission selection CSV v2

入試の募集段階・選抜区分・募集単位・指標別出典を、4ファイルのbundleで検査してSQL化する。

```powershell
node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> --validate-only
node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> --out <output.sql>
```

このコマンドはDBへ接続しない。生成SQLの適用には、別途バックアップとユーザー承認が必要。

## ファイル

- `admission-recruitment-units-v2.csv`: 学科、くくり募集、学校全体、定時制の部などの募集単位
- `admission-selection-stats-v2.csv`: 年度・募集段階・選抜区分・公表scopeごとの数値
- `admission-selection-sources-v2.csv`: capacity/applicants等の指標別出典
- `admission-selection-quality-flags-v2.csv`: 欠損・範囲不一致・到達不能等の理由

複数値は `|` で区切る。`department_names` と `exam_component_codes` 以外で独自の複数値表現を作らない。

4ファイルは `school_name` の直後に任意の `school_record_key` を持てる。同名の旧校・新校が併存する場合は必須で、DBの `schools.record_key` と校名・都道府県の3項目を一致させる。移行前bundleの旧headerも読み込めるが、`pref + school_name` が複数校に一致した時は推測せずエラーにする。

## 主な拒否条件

- master未登録のstage/track/unit kind/map role/reason/exam component
- 比較可能行のcapacityまたはapplicants欠損
- 比較可能な`primary_total`の指標別出典不足
- 比較可能な`primary_total`のcapacity/applicants出典が未検証またはHTTP 400以上
- 同じ学校・年度で地図対象募集単位の学科membershipが重複
- 学校全体行と学科・学科群行の同時採用
- 県別に登録されていない公式host、商用受験サイト、http(s)以外のURL、80字超の根拠引用

新しい都道府県を追加するときは、県教委の公式hostを`OFFICIAL_HOST_SUFFIXES`へ先に登録する。

`fixtures/synthetic/` は実在校・実在数値を使わない検査用bundle。
