# Admission selection CSV v2

入試の募集段階・選抜区分・募集単位・指標別出典を、4ファイルのbundleで検査してSQL化する。

```powershell
node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> --validate-only
node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> --out <output.sql>
```

西日本 v0.4 以降の本番候補は、学校を県単位で全置換しない。次の契約を必須にする。

```powershell
node scripts/admission/gen-admission-v2.mjs `
  --dir <bundle-dir> `
  --out <admission-v2.fragment.sql> `
  --input-schools-only `
  --fragment
```

- 4 CSV の全行に `school_record_key` を入れる。
- 募集単位 CSV の学科 membership は、表示用 `department_names` と同じ順序で `department_record_keys` を `|` 区切り指定する。
- bundle root に `replacement-scope.csv` を置き、`pref,school_name,school_record_key,complete_school_snapshot` の固定 header を使う。
- `complete_school_snapshot=true` は、その学校の全年度・全metricを含む完全snapshotだけに付ける。部分取得の学校は置換対象へ入れず quarantine する。
- `--fragment` の出力は `BEGIN` / `COMMIT` を持たない。schema → identity → lifecycle → departments → admission → assert をまとめる `apply-candidate.sql` が単一transactionを所有する。
- 生成SQLは対象件数を入力と完全一致させ、対象外 admission 7表の件数とSHA-256 fingerprintが変わらないことをtransaction内でassertする。

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

## 学校候補の不変条件検査（schools-candidate-check.mjs）

```powershell
node scripts/admission/schools-candidate-check.mjs <schools-candidate.csv>
```

`gen-admission-v2.mjs` は admission 4 CSV しか見ないため schools 表の defect を検出できない。
S4（本番schema相当への適用）で落ちる条件を S1 の段階で止めるための検査。違反があれば exit 1。

- `course_times` が空（`schools_course_times_nonempty` CHECK 違反）
- `gender_type='female'`（正しくは `girls`）・未知の gender_type
- `type='secondary_education_school'`（正しくは `high_school`）
- `campus_type='satellite'`（正しくは `satellite_campus`）
- `record_key` の空・重複

いずれも過去に S4 まで持ち越された実績のある defect（奈良・岐阜・三重・大阪・京都・佐賀・福岡）。
新しい県の S1 を終えたら、S2 へ進む前にこれを通すこと。

## PDF抽出（pdf-extract.mjs）

入試PDFをper-school行のCSVへ復元する。テキスト化エンジンを`--engine`で選ぶ。

```powershell
node scripts/admission/pdf-extract.mjs <pdf> --out <csv>                    # auto（既定）
node scripts/admission/pdf-extract.mjs <pdf> --engine pymupdf --out <csv>   # PyMuPDF固定
```

- `auto`: poppler `pdftotext -layout` を試し、出力が空・`(cid:NNN)`羅列・置換文字だらけ・CJKゼロ・pdftotext未導入のいずれかならPyMuPDFへフォールバックする
- `poppler`: `pdftotext`のみ
- `pymupdf`: `pymupdf-extract.py`（`pip install pymupdf`が必要）。単語の座標から列を復元し、`--gap <pt>`で列区切りの閾値を調整できる。Pythonは`MANABI_PYTHON`で明示指定できる

福岡S02・長崎R8 capacityのようにCIDフォントで埋め込まれた表は、popplerでは字形を復元できずPyMuPDFが必要。

抽出は完全ではない。学校名が確定しない行は`<out>.quarantine.csv`へ落ちるので、採否は人間が確認する。
