#!/usr/bin/env python3
"""pdf-extract.mjs (T1) の PyMuPDF エンジン本体。

poppler pdftotext は CJK の CID フォント（ToUnicode を持たない埋め込みサブセット）を
解決できず、福岡 S02 268332.pdf・長崎 R8 capacity PDF のような入試表で本文が空欄や
(cid:NNN) 羅列になる。PyMuPDF (MuPDF) は同じ PDF から字形を復元できるため、
本スクリプトを subprocess として呼び出しレイアウト保持テキストを stdout へ書く。

出力は pdftotext -layout 互換の「列の切れ目を 2 個以上の空白で表したテキスト」。
pdf-extract.mjs の parseSchoolRows() が空白 2 個以上でトークン分割するため、
単語の x 座標の隙間が --gap（pt）以上なら列区切りとみなして空白 3 個を挟む。

実行:
  python scripts/admission/pymupdf-extract.py <pdf-path> [--gap 4.0] [--first-page N] [--last-page N]

本スクリプトは DB へ接続しない。抽出結果の採否・投入は別途人間が確認する。
"""

from __future__ import annotations

import argparse
import sys

# PyMuPDF 1.24 以降は `pymupdf` が正式名で `fitz` は後方互換エイリアス。
# 環境差で片方しか無いことがあるため両方試す。
try:
    import pymupdf  # type: ignore
except ImportError:  # pragma: no cover - 環境依存
    try:
        import fitz as pymupdf  # type: ignore
    except ImportError:
        sys.stderr.write(
            'PyMuPDF が見つかりません。`pip install pymupdf` で導入してください。\n'
        )
        raise SystemExit(3)

# 同一行とみなす y 座標の許容差（pt）。表の行間より十分小さく、
# 行内の上下ぶれ（ルビ無し前提の中央揃えずれ）は吸収できる値。
LINE_TOLERANCE_PT = 3.0

# 列区切りとみなす x 方向の隙間（pt）の既定値。
# 日本語 10.5pt 相当の全角 1 文字幅の 4 割程度を目安にした。
DEFAULT_GAP_PT = 4.0

COLUMN_SEPARATOR = '   '


def group_words_into_lines(words, tolerance=LINE_TOLERANCE_PT):
    """PyMuPDF の word タプル列を、y 座標が近いものごとの行へまとめる。

    words: (x0, y0, x1, y1, text, block_no, line_no, word_no) のリスト。
    戻り値: 行ごとの word リスト（各行は x0 昇順、行同士は y0 昇順）。
    """
    lines = []
    for word in sorted(words, key=lambda w: (round(w[1], 1), w[0])):
        y0 = word[1]
        for line in lines:
            if abs(line['y0'] - y0) <= tolerance:
                line['words'].append(word)
                break
        else:
            lines.append({'y0': y0, 'words': [word]})
    for line in lines:
        line['words'].sort(key=lambda w: w[0])
    lines.sort(key=lambda line: line['y0'])
    return [line['words'] for line in lines]


def is_ascii_word_char(char):
    return char.isascii() and char.isalnum()


def render_line(words, gap_pt=DEFAULT_GAP_PT):
    """1 行分の word を、列の隙間を空白 3 個で表した 1 行テキストへ整形する。

    隙間が gap_pt 未満のときの連結は pdftotext -layout の見た目に合わせる:
    日本語は分かち書きしないので空白を入れず直結し、英数字が隣接する場合だけ
    空白 1 個を入れて語の切れ目を保つ。ここで CJK の間に空白を入れてしまうと、
    pdf-extract.mjs 側の学科名キーワード判定（例: 「総合」）が
    「総 合」に化けてすり抜け、学科名を学校名として拾ってしまう。
    """
    parts = []
    previous = None
    for x0, _y0, x1, _y1, text, *_rest in words:
        if previous is not None:
            previous_x1, previous_text = previous
            if x0 - previous_x1 >= gap_pt:
                parts.append(COLUMN_SEPARATOR)
            elif (previous_text and is_ascii_word_char(previous_text[-1])) or (
                text and is_ascii_word_char(text[0])
            ):
                parts.append(' ')
        parts.append(text)
        previous = (x1, text)
    return ''.join(parts).rstrip()


def extract_text(pdf_path, gap_pt=DEFAULT_GAP_PT, first_page=None, last_page=None):
    """PDF 全体（または指定頁範囲）をレイアウト保持テキストへ変換する。"""
    out = []
    with pymupdf.open(pdf_path) as document:
        start = (first_page or 1) - 1
        end = last_page or document.page_count
        for page_index in range(max(start, 0), min(end, document.page_count)):
            page = document[page_index]
            lines = group_words_into_lines(page.get_text('words'))
            for words in lines:
                out.append(render_line(words, gap_pt))
            # pdftotext と同じく改頁を空行で表す（parseSchoolRows は空行を読み飛ばす）。
            out.append('')
    return '\n'.join(out) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description='PyMuPDF でレイアウト保持テキストを抽出する')
    parser.add_argument('pdf')
    parser.add_argument('--gap', type=float, default=DEFAULT_GAP_PT)
    parser.add_argument('--first-page', type=int, default=None)
    parser.add_argument('--last-page', type=int, default=None)
    args = parser.parse_args(argv)

    text = extract_text(args.pdf, args.gap, args.first_page, args.last_page)
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
