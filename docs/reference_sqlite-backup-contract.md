---
type: reference
status: draft
tags: [sqlite, backup, restore, synthetic]
owner: ishizakahiroshi
review_status: draft
related: [docs/plan_subdomain-entry-school-migration_c1_sqlite-static-source.md]
last_reviewed: 2026-09-27
---

# 学校原本の世代バックアップ・復元契約

[SQLite計画C2](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md)のローカル実装。Python 3.14標準ライブラリ、既存school schema 3の合成原本が対象。利用者DB、他サービスの原本、実原本の取得や切替は対象外。

## 世代の完成条件

`backup.py`はSQLite Backup APIでread-only接続から独立したDBを作る。稼働中のDB本体だけをファイルコピーしない。SQLiteは他の接続が利用中でもBackup APIを使用できるが、競合や継続更新による待ちがあるため、期限付きで中断できる形にする。[PythonのBackup API](https://docs.python.org/3.14/library/sqlite3.html#sqlite3.Connection.backup)、[SQLiteのBackup API](https://www.sqlite.org/backup.html)。

世代は新規ディレクトリ内の`database.sqlite`と`manifest.json`。既存ディレクトリは空でも上書きしない。完成したDBの整合性・FK・全行・原本版・件数・公開用投影の内容hashを検査し、ファイルを同期書込みしてmanifestを最後に置く。manifestが欠けた世代は完成扱いにしない。アプリ例外の回収と、電源断後の媒体耐久性は別の保証である。

manifestは次の10キーのみ。追加の実パスや原本行を含めない。

| キー | 内容 |
|---|---|
| format / format_version | `school-source-backup` / 整数`1` |
| synthetic / schema_version | `true` / 整数`3` |
| dataset_version / source_version | バックアップ内DBの原本版・入力版 |
| created_at | 時差を明示した世代作成時刻 |
| database_sha256 | 完成DBファイル全bytesのSHA-256 |
| table_counts | 学校原本25表の件数 |
| snapshot_content_sha256 | 既存学校snapshotと同じ正規化内容hash |

ファイルhashは全原本の破損検出、投影内容hashは復元後の生成結果の比較に使う。hashとmanifestは署名ではない。合成宣言は実データを識別する機能ではなく、実値を付け替えて通してはならない。

合成原本の更新・取消で作る`source_apply_receipts`も、既知の表定義と各記録の構造・hashを照合してDB内に保持する。復元後も過去の更新記録と取消記録を参照でき、取消済み要求の再適用を拒否する。原本25表の件数と公開用snapshotにはこの内部記録を含めない。未知の表・index・triggerは引き続き拒否する。

## APIと実行の境界

Python APIは`scripts/local-data`をmodule検索パスに加えて使う。統合CLIは`school_backup.py`。次の例はリポ外・同期外の合成専用領域を使い、親ディレクトリを先に用意する。出力先に既存原本を指定しない。

```text
python -B scripts/local-data/school_backup.py create --source <scratch>/schools-v3.sqlite --output <scratch>/generations/generation-001
python -B scripts/local-data/school_backup.py create --source <scratch>/schools-v3.sqlite --output <scratch>/generations/generation-001 --apply
python -B scripts/local-data/school_backup.py verify --generation <scratch>/generations/generation-001
python -B scripts/local-data/school_backup.py replicate --generation <scratch>/generations/generation-001 --output <scratch>/replica-001 --apply
python -B scripts/local-data/school_backup.py restore --generation <scratch>/replica-001 --output <scratch>/restored.sqlite --apply
python -B scripts/local-data/school_backup.py retention --root <scratch>/generations --keep <explicit-count>
```

retentionのroot直下は世代ディレクトリだけとする。CLIで検証拒否・保持判定blockedは非ゼロ終了。出力表示だけが失敗した場合は、既に完成した成果物を戻さず、verifyで状態を確認する。

- `backup.create_backup(source, destination, apply=False)`：既定はdry-run。検査はするが指定出力を作らない。`apply=True`だけで新規世代を作成。
- `backup.verify_backup(generation)`：完成した2ファイルとDBの整合を再検査し、manifestを返す。
- `backup.restore_backup(generation, destination, apply=False)`：既定はdry-run。`apply=True`で別の新規SQLiteパスに復元し、既存原本は上書きしない。
- `backup_replica.replicate_backup(generation, destination, apply=False)`：検証済み世代を別の明示ローカルパスへ複製する。同じ内容の既存完成コピーは再利用可、異なる内容や不完全な出力は拒否する。
- `backup_replica.retention_plan(root, keep)`：明示した保持数に従い保持/削除候補を返す。削除は実装しない。未完成・破損世代を見つけたら削除候補を空にして止める。

入力や出力のsymlink/junction、ファイルhardlinkは受理しない。元DBで通常のWALを使っていてもBackup APIで確定済み内容を取得する。復元対象や完成世代のsidecarは完成状態を曖昧にするため受理しない。検証済み世代は書込み用DBとして開かず、変更が必要なら別場所へ復元して新しい世代を作る。

## 複製と保持

ローカルの複製・再読取り成功からGoogle Driveへの同期完了を推定しない。複製結果の`cloud_sync`は`unverified`。`backup_replica.py`は制御されたローカルパス用でUNCを受け付けない。UNC転送は下記の別transportで扱い、実クラウドへの転送、暗号化/共有範囲の確認も別に行う。

### UNCとRDP転送ドライブ

`backup_transport.copy_backup_to_unc(generation, destination, apply=False, timeout_seconds=30.0, rdp_drive=False)`は、検証済みローカル世代の2ファイルだけを明示UNC先へ転送する。統合CLIは`school_backup.py replicate-remote --generation <scratch>/generations/generation-001 --output <explicit-unc-generation>`。既定は無書込み、`--apply`で新規先へ転送する。親ディレクトリは既存とし、manifestを最後に置く。ローカル原本のUNC対応を有効にするものではない。

転送後は通常ファイルとして読み戻し、ローカル一時領域でSQLite・manifest・内容hashを検証する。SQLiteをネットワークパスで開かない。既存の完全一致世代は再検証して`already_present`、異なる世代や不完全先は拒否する。切断・失敗時のリモート削除はせず、手元の完成世代も残す。不完全な試行は新しい保存先名を明示して再試行する。常駐再試行やタスクスケジューラへの登録は含めない。

通常UNCはファイル識別番号を照合する。RDPの転送ドライブでは同一ファイルでも識別番号が再取得ごとに変わる実測があるため、明示`--rdp-drive`（APIの`rdp_drive=True`）を用意する。このモードは`tsclient`の単一ドライブ文字の共有だけを受理し、識別番号の永続性を前提にしない。型・reparse・fileのlink数・サイズ・更新日時と読戻し内容を検査するが、directory差替えの同一性証明はできない。書込み先を他プロセスが変更しない管理下の専用領域で使う。

`--timeout-seconds`は処理間の期限検査で、停止中のOSネットワークI/Oを強制中断する保証ではない。読戻し成功はその時点の内容一致であり、RDP切断後の可用性、物理媒体の独立性、電源断耐久性、Drive同期完了の証明ではない。

保持数は自動採用しない。容量、作成頻度、世代サイズ、復元検収済みの世代を確認して決める。同じDB版でも更新前・公開候補確定時などの必要な世代を区別する。削除候補一覧は実行許可ではなく、破損や作業中世代を消して検査を通さない。

## 検証と残る検収

合成DBで取込み→バックアップ→ローカル複製→別場所への復元→既存export→公開用内容hashの一致を確認する。途中失敗・容量不足相当の書込み例外・破損・既存先競合・未完成世代・書込み中WALも対象とする。実行した件数と結果はC2計画へ記録する。

物理媒体の故障独立性、クラウド同期完了、実容量に基づく保持数、暗号化とアクセス範囲、電源断・OS強制終了・実媒体故障、実原本からの復元は未検収。Supabaseの既存nightly backupを置換しない。
