# 学校版 Android 試作

既存の高校Web版を開くTWAの最小プロジェクト。Google / LINEの認証、Supabaseの保存、CloudflareのAPIは既存Web版を使う。アプリ内にWebViewや認証SDKを追加しない。オンライン利用を前提とする。

2026-09-27にdebug APKのビルド・Android Lintを確認済み。初版0.1.0の起動停止を端末ログで確認し、0.1.1への上書き後、Redmi 12 5G / Android 15で高校ホーム画面の表示を確認した。実ログイン・保存・再起動などの検収は残る。

## 設定

`pilot.json`に試作用の識別子・表示名・起動URLを分けて置く。`.pilot`の識別子は公開アプリのIDとして確定したものではない。学校サイトの移行時には起動URLを見直す。現在の `/` を総合入口への切替後も使い続けない。

TWAの所有確認が通るまでは、URLバー付きのCustom Tabとして開く。これは初期の認証確認には使えるが、全画面TWAの検証完了にはならない。Google / LINEへ移動している間にブラウザのバーやLINEアプリが表示されることもある。

## 開発環境とビルド

JDK 17、Gradle 8.13、Android SDK Platform 36 / Build Tools 35.0.0 / Platform Toolsが必要。Android Gradle Pluginは8.13.2、Android Browser Helperは2.7.3に固定している。依存の取得とSDKライセンスの確認は環境導入時に行う。

環境を用意した後、`android/pilot`を作業ディレクトリとして実行する。`JAVA_HOME`をJDKへ、`ANDROID_HOME`をSDKへ設定する。Gradle未導入の場合は先に公式配布物を用意する。WindowsではPowerShellから `gradle.bat` を使う。

```powershell
gradle.bat --no-daemon :app:assembleDebug :app:lintDebug
```

APKは `app/build/outputs/apk/debug/app-debug.apk`。本人がUSBデバッグを許可した端末を1台指定し、Platform Toolsの `adb` で導入する。複数端末へ一括導入しない。アンインストールやブラウザのストレージ消去は既存データに影響し得るため、確認手段として実行しない。

```powershell
adb -s <device-id> install -r app/build/outputs/apk/debug/app-debug.apk
```

## ビルド確認の記録

- `:app:assembleDebug :app:lintDebug` が成功し、Android Lintは `No issues found.`。JDK 17.0.20.1、Gradle 8.13、SDK Platform 36 revision 2、Build Tools 35.0.0で確認した。
- `apksigner verify --verbose` は終了0、v1 / v2署名の検証に成功。旧v1方式では依存物の `META-INF` に未保護エントリの警告が出る。API 24以上を指定した検証ではv2で成功し警告なし。依存のライセンス・メタデータを警告対策として削除しない。
- Gradleには9.0への互換性に関する非推奨警告が残る。検証した8.13を使い、9系への更新は別途確認する。
- APK内のアプリID・起動URL・Custom Tabsの設定を検査済み。追加の実行時権限は要求していない。Android 12以降のバックアップ・端末間移行から試作ラッパーの保存領域を除外するルールを明示した。ブラウザ自身の保存領域はこの設定の対象外。
- 初回ビルド時はADB接続なし。その後ワイヤレスADBでRedmi 12 5Gに接続し、0.1.1のホーム画面表示を確認した。認証・保存成功とは扱わない。Play提出用のAABと署名は未準備。

## 起動停止への対応（0.1.1-pilot）

初版APKには `ManageDataLauncherActivity` の宣言が欠けていた。組み込まれたAndroid Browser Helper 2.7.3の実バイナリを調べると、`LauncherActivity.launchTwa` は `addSiteSettingsShortcut` を呼び、そのメソッドはAPI 25以降で当該コンポーネントの有効・無効を操作する。Chrome側の対応有無の両分岐がこの操作を行う。公式の[実装](https://github.com/GoogleChrome/android-browser-helper/blob/main/androidbrowserhelper/src/main/java/com/google/androidbrowserhelper/trusted/ManageDataLauncherActivity.java)と[サンプル](https://github.com/GoogleChrome/android-browser-helper/blob/main/demos/twa-basic/src/main/AndroidManifest.xml)も参照した。

当該Activityを非公開として宣言し、管理画面URLと `manageSpaceActivity` を設定した。アプリIDと署名を維持してversionCodeを2へ上げた。後続の端末確認で、インストール済みはまだ0.1.0と判明。クラッシュ記録に `IllegalArgumentException: Component class ...ManageDataLauncherActivity does not exist` と、`addSiteSettingsShortcut → launchTwa → onCreate` の呼び出しを確認した。

同端末へ0.1.1をADBで上書きし、実効版がversionCode=2 / versionName=0.1.1-pilotになったことを確認。MAIN / LAUNCHERのIntentで起動するとChromeのCustomTabActivityで高校ホームが表示され、起動時刻以降からスクリーンショット取得後までのクラッシュ記録に対象アプリは0件だった。実機はRedmi 12 5G（23076RA4BR）、Android 15、Chrome 153.0.8010.52。画面証跡は `out/redmi-0.1.1-home.png`（Git対象外）。長時間稼働・Google / LINE認証の検証結果ではない。

次の検査はソースXMLだけでなく、出来上がったAPKのActivity宣言を検査する。初版APKを渡すと登録漏れで失敗し、0.1.1では成功することを確認した。実機起動を代用する検査ではない。

```powershell
pwsh -File tools/verify-apk.ps1 -Apk app/build/outputs/apk/debug/app-debug.apk -Aapt "$env:ANDROID_HOME/build-tools/35.0.0/aapt.exe"
```

再配布用コピーは `out/manabi-school-pilot-0.1.1.apk`（Git対象外）。Googleドライブ等へこの新版をアップロードして端末で更新する。旧版のアンインストールやChromeの保存データ消去は不要。

## サイトとの対応付け（全画面化）

全画面TWAには、起動先originの `/.well-known/assetlinks.json` が実際の配信署名を信頼している必要がある。標準debug署名を本番で信頼させない。認証を含めた試験先・専用署名を確定してから公開候補を作る。

```powershell
node tools/assetlinks.mjs <certificate-sha256>
node --test tools/assetlinks.test.mjs
```

候補はgitignore対象の `out/assetlinks.json` のみに出力される。このコマンドはWeb配信物・本番設定を変更しない。Play配信時の署名はローカルAPKの署名と異なる場合があるため、公開工程で再確認する。

## 実機での合格条件

1. アイコンから高校版を開き、検索・地図・学校詳細を表示できる。
2. GoogleとLINEをそれぞれ試し、ログイン後に高校画面へ戻る。LINEアプリの有無も記録する。
3. 同じログイン手段・同じアカウントで、Web版の既存のお気に入り・メモが表示される。GoogleとLINEのアカウントが自動で統合されるとは扱わない。
4. アプリを閉じて再起動し、セッションとデータを確認する。ゲストからのアカウント連携は別の確認項目とする。
5. ログインの取消・戻る操作・通信切断から復帰できる。外部リンクや日本語キーボードで操作が詰まらない。
6. サイトの所有確認を設定した後、Play配布予定の署名でも全画面表示と認証復帰を確かめる。

ブラウザの保存データはアプリ本体とは別に管理される。同じorigin・ブラウザかどうかを記録し、匿名データの移行や削除を推測で扱わない。認証コード・トークンをログや検収画像に残さない。

## 参照

- [Android Browser Helper](https://github.com/GoogleChrome/android-browser-helper)
- [TWAの概要](https://developer.chrome.com/docs/android/trusted-web-activity)
- [AGP 8.13の互換表](https://developer.android.com/build/releases/agp-8-13-0-release-notes)
- [Androidのバックアップ設定](https://developer.android.com/identity/data/autobackup)

本プロジェクトのソースにはリポジトリルートのLICENSEを適用する。依存ライブラリのライセンスは各配布物の表示を維持する。
