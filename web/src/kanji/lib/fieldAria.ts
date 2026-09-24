// 入力欄のエラーを読み上げで伝えるための aria 属性を計算する純粋な関数（C8 レビュー should 1）。
// pages/ProfileEditPage.tsx の JSX から直接書くと、DOM が無い vitest（環境は node）から
// 「エラー時に aria-invalid="true" になる」を検証する手段が無くなる（クリックなどで実際に
// エラーを起こせない）。ここへ出すことで、React の描画を経由せずに確かめられる。

export interface FieldAria {
  ariaInvalid: true | undefined
  ariaDescribedBy: string | undefined
}

/** ニックネーム欄。常にヒント（kanji-edit-nick-hint）を describe し、エラー時はエラー文も足す */
export function nickFieldAria(hasError: boolean): FieldAria {
  return {
    ariaInvalid: hasError ? true : undefined,
    ariaDescribedBy: hasError ? 'kanji-edit-nick-hint kanji-edit-nick-error' : 'kanji-edit-nick-hint',
  }
}

/** 試験の予定日欄。ヒントは無いので、エラー時だけ describedby を持つ */
export function examFieldAria(hasError: boolean): FieldAria {
  return {
    ariaInvalid: hasError ? true : undefined,
    ariaDescribedBy: hasError ? 'kanji-edit-exam-error' : undefined,
  }
}
