#!/usr/bin/env python3
"""字幕を1行1枚の透過PNGにする。

    python3 src/pipeline/h3/render-subs.py <epId>

入力: episodes/<epId>/timing.json の各行
出力: h3/episodes/<epId>/subs/sub_<lineId>[_<k>].png と subs/subs.json(表示窓の台帳)

**字幕は1回の表示につき1文**(2026-09-04・ユーザー指示。bible §8)。台本の1行に複数の文が
あれば、句(phrases)の時刻を使って文ごとに分け、それぞれの表示窓を subs.json に書く。
assemble / preview はこの台帳を読んで重ねる(台帳に無い行は従来どおり行全体=1枚)。
1文でも SENTENCE_MAX_CHARS を超えるときは、句の切れ目のうち中央に近い所で2つに割る。

見た目は実装側 (assets/hf/animal-style.css の .subtitle) に合わせる:
  Yusei Magic 46px / 文字色 #F4F1E7 / 背景 #1B1A17 @82% / 角丸14px
  余白 12px 30px / 下から72px / 中央寄せ / 最大幅82% / 字間0.03em / 行高1.3
ASS では角丸が出せず、太さも色も合わなかったのでこちらで描く。
**この定数群は v2 の実測で合わせ込んだもの。変えない。**
"""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

W, H = 1920, 1080
FONT_PATH = os.path.join(ROOT, "assets/fonts/YuseiMagic-Regular.ttf")
FONT_SIZE = 46
TEXT_COLOR = (244, 241, 231, 255)          # --animal-paper
BOX_COLOR = (27, 26, 23, int(255 * 0.82))  # --animal-ink @0.82
RADIUS = 14
PAD_X, PAD_Y = 30, 12
BOTTOM = 72
MAX_W = int(W * 0.82)
TRACKING = round(FONT_SIZE * 0.03)         # letter-spacing: 0.03em
LINE_H = round(FONT_SIZE * 1.3)
SENTENCE_END = "。！？!?"
SENTENCE_MAX_CHARS = 42


def text_width(font, s):
    """字間を足した実幅。PIL は letter-spacing を持たないので1文字ずつ積む。"""
    if not s:
        return 0
    return sum(font.getlength(ch) for ch in s) + TRACKING * (len(s) - 1)


def wrap(font, s, limit):
    lines, cur = [], ""
    for ch in s:
        if text_width(font, cur + ch) > limit and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def draw_line(draw, font, s, x, y):
    for ch in s:
        draw.text((x, y), ch, font=font, fill=TEXT_COLOR)
        x += font.getlength(ch) + TRACKING


def render(text, out_path):
    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    lines = wrap(font, text, MAX_W - PAD_X * 2)
    box_w = round(max(text_width(font, l) for l in lines)) + PAD_X * 2
    box_h = LINE_H * len(lines) + PAD_Y * 2

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0 = (W - box_w) // 2
    y0 = H - BOTTOM - box_h
    d.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=RADIUS, fill=BOX_COLOR)

    for i, line in enumerate(lines):
        lw = text_width(font, line)
        lx = (W - lw) / 2
        # 行の縦位置は行高の中で上寄せ。ascent 基準のズレを行高の 15% で補正する
        ly = y0 + PAD_Y + i * LINE_H + round(LINE_H * 0.08)
        draw_line(d, font, line, lx, ly)

    img.save(out_path)
    return out_path


def subtitle_text(line):
    """字幕に焼く表記。

    台本の `- display:` は tts.ts が phrases[].displayText として timing.json へ落とす
    (読みをひらがなに開いた行でも字幕は漢字で出すための仕掛け)。**HF経路の
    SubtitleLayer はこれを見るが、H3の字幕焼きは line["text"](読み表記)をそのまま
    焼いていた** ため、「しゅ」「ながければ」のような読み表記が画面に出ていた
    (ep019-polarbear の人間目視で発覚。2026-08-27)。
    全フレーズに displayText があるときだけ連結して使い、無ければ従来どおり読み表記へ落ちる。
    """
    phrases = line.get("phrases") or []
    if not (phrases and all(p.get("displayText") for p in phrases)):
        return line["text"]
    # フレーズは句読点を落とした形で入っているので、読み表記の行から区切り文字を
    # 拾い直して挟む(連結しただけだと「超えます長ければ」のように句点が消える)。
    raw = line["text"]
    out, pos = [], 0
    for ph in phrases:
        i = raw.find(ph["text"], pos)
        if i < 0:
            return "".join(x["displayText"] for x in phrases)
        out.append(raw[pos:i])
        out.append(ph["displayText"])
        pos = i + len(ph["text"])
    out.append(raw[pos:])
    return "".join(out)


def split_sentences(line):
    """行を文の単位に分け、[(表示文字列, startSec, endSec)] を返す。

    句(phrases)の並びを読み表記の行(line["text"])に当てはめ、句の直後に句点類が
    続いていれば文の切れ目とみなす。表示文字列は displayText(無ければ読み表記)を
    句点類ごと連結したもの。句が無い・当てはまらない行は行全体を1文として返す。
    表示窓は「その文の最初の句の開始」から「次の文の最初の句の開始」まで(最初の文は
    行頭から、最後の文は行末まで)。行間の無音は次の文に渡さない。
    """
    phrases = line.get("phrases") or []
    raw = line["text"]
    whole = [(subtitle_text(line), line["startSec"], line["endSec"])]
    if not phrases:
        return whole
    groups, cur, pos = [], [], 0
    for ph in phrases:
        i = raw.find(ph["text"], pos)
        if i < 0:
            return whole
        cur.append((raw[pos:i], ph))
        pos = i + len(ph["text"])
        # 句の直後の区切り文字を読む(「。」「!?」など)。文末なら文を閉じる
        j = pos
        while j < len(raw) and raw[j] in "、。！？!?,.」』)":
            j += 1
        tail = raw[pos:j]
        if any(ch in SENTENCE_END for ch in tail):
            groups.append((cur, tail))
            cur = []
            pos = j
    if cur:
        groups.append((cur, raw[pos:]))
    if len(groups) <= 1 and not _too_long(groups):
        return whole
    groups = _split_long(groups)
    out = []
    for gi, (items, tail) in enumerate(groups):
        text = "".join(sep + (ph.get("displayText") or ph["text"]) for sep, ph in items) + tail
        text = text.strip()
        start = line["startSec"] if gi == 0 else items[0][1]["startSec"]
        end = line["endSec"] if gi == len(groups) - 1 else groups[gi + 1][0][0][1]["startSec"]
        out.append((text, start, end))
    return out


def _group_len(items):
    return sum(len(sep) + len(ph.get("displayText") or ph["text"]) for sep, ph in items)


def _too_long(groups):
    return any(_group_len(items) > SENTENCE_MAX_CHARS for items, _ in groups)


def _split_long(groups):
    """SENTENCE_MAX_CHARS を超える文を、句の切れ目のうち中央に近い所で2つに割る。"""
    out = []
    for items, tail in groups:
        n = _group_len(items)
        if n <= SENTENCE_MAX_CHARS or len(items) < 2:
            out.append((items, tail))
            continue
        best, best_d = 1, None
        acc = 0
        for k in range(1, len(items)):
            acc += len(items[k - 1][0]) + len(items[k - 1][1].get("displayText") or items[k - 1][1]["text"])
            d = abs(acc - n / 2)
            if best_d is None or d < best_d:
                best, best_d = k, d
        head, rest = items[:best], items[best:]
        # 後半の先頭の区切り(読点)は前半の末尾に付ける
        lead, first = rest[0]
        rest = [("", first)] + rest[1:]
        out.append((head, lead.strip()))
        out.extend(_split_long([(rest, tail)]))
    return out


def main():
    if len(sys.argv) < 2:
        print("使い方: python3 src/pipeline/h3/render-subs.py <epId>", file=sys.stderr)
        return 2
    ep_id = sys.argv[1]
    timing_path = os.path.join(ROOT, "episodes", ep_id, "timing.json")
    if not os.path.exists(timing_path):
        print("timing.json がありません: " + timing_path, file=sys.stderr)
        return 1
    out_dir = os.path.join(ROOT, "h3/episodes", ep_id, "subs")
    os.makedirs(out_dir, exist_ok=True)

    timing = json.load(open(timing_path, encoding="utf-8"))
    made = []
    split_lines = 0
    for line in timing["lines"]:
        parts = split_sentences(line)
        if len(parts) > 1:
            split_lines += 1
        for k, (text, start, end) in enumerate(parts):
            name = "sub_%s.png" % line["lineId"] if len(parts) == 1 else "sub_%s_%d.png" % (line["lineId"], k)
            path = os.path.join(out_dir, name)
            render(text, path)
            made.append({"id": line["lineId"], "seq": k, "png": path, "text": text,
                         "start": start, "end": end})
    with open(os.path.join(out_dir, "subs.json"), "w", encoding="utf-8") as fh:
        json.dump(made, fh, ensure_ascii=False, indent=1)
    print("%d 枚 → %s(%d 行を文ごとに分割)" % (len(made), out_dir, split_lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
