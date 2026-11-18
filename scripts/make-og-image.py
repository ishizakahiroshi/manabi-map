"""共有画像（OGP・1200x630）を 1 枚作る。X・LINE・Slack などのリンクカードに出る画像。

各サービスの icon-512.png（または --mark chifact の文字の印）と、名前・一言を載せる。
使い方:
  python scripts/make-og-image.py --icon web/public/icon-512.png --title まなびマップ \
      --sub "学ぶことも、通う場所も。" --host manabi-map.app --out web/apex-portal/og-image.png
"""
import argparse
from PIL import Image, ImageDraw, ImageFont

PAPER, CARD, INK, ORANGE, PEACH, MUTED = '#f7f3ea', '#fffdf8', '#241f1a', '#ff7a3d', '#ffe7d6', '#635b52'
BOLD, MEDIUM = 'C:/Windows/Fonts/YuGothB.ttc', 'C:/Windows/Fonts/YuGothM.ttc'
W, H = 1200, 630


def dark(hex_color):
    # 文字に使う濃さへ寄せる（黄色などの明るい色でも読めるように、各色を 55% に落とす）
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return '#%02x%02x%02x' % (int(r * .55), int(g * .55), int(b * .55))


def font(path, size):
    return ImageFont.truetype(path, size)


def fit(draw, text, path, size, max_w):
    while size > 28 and draw.textlength(text, font=font(path, size)) > max_w:
        size -= 2
    return font(path, size)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--icon')
    p.add_argument('--mark', choices=['chifact'])
    p.add_argument('--title', required=True)
    p.add_argument('--sub', required=True)
    p.add_argument('--host', required=True)
    p.add_argument('--accent', default=ORANGE)
    p.add_argument('--out', required=True)
    a = p.parse_args()

    img = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(img)
    # 下の帯と、左の印を置く丸い台
    d.rectangle([0, H - 18, W, H], fill=a.accent)
    cx, cy, r = 280, 300, 190
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PEACH if a.accent == ORANGE else '#dcebe8')
    if a.icon:
        icon = Image.open(a.icon).convert('RGBA').resize((300, 300), Image.LANCZOS)
        img.paste(icon, (cx - 150, cy - 150), icon)
    elif a.mark == 'chifact':
        # 地ファクトの印: 正方形を縦線で割った形（色はサービスの緑）
        d.rectangle([cx - 90, cy - 90, cx + 90, cy + 90], outline=a.accent, width=22)
        d.line([cx, cy - 90, cx, cy + 90], fill=a.accent, width=22)
    tx, mw = 540, W - 540 - 60
    title = fit(d, a.title, BOLD, 96, mw)
    d.text((tx, 190), a.title, font=title, fill=INK)
    sub = fit(d, a.sub, MEDIUM, 44, mw)
    d.text((tx, 330), a.sub, font=sub, fill=MUTED)
    d.text((tx, 470), a.host, font=font(MEDIUM, 34), fill=dark(a.accent))
    img.save(a.out, optimize=True)
    print(f'wrote {a.out}')


main()
