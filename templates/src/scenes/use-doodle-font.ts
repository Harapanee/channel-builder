/**
 * チャンネルの本文書体のロード。
 *
 * どの書体を使うかは style.ts の `DOODLE_FONT` 契約が唯一の参照
 * (既定 = 手描き風 "Yusei Magic" / このチャンネル = "Rounded Mplus 1c" Black)。
 *
 * @remotion/google-fonts 等のネットワークロードは使わず、
 * assets/fonts/ に同梱した TTF を staticFile + FontFace + delayRender/continueRender
 * でロードする。字幕(Episode.tsx)と TitleCard / SpeechBubble などで使用する。
 */
import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { DOODLE_FONT } from "./style";

/**
 * FontFace に登録する生のファミリー名(= TTF の内部ファミリー名)。
 * **CSS の font-family 値として直に使わないこと** — 引用符が要る(下記 DOODLE_FONT_CSS)。
 */
export const DOODLE_FONT_FAMILY: string = DOODLE_FONT.family;

/**
 * CSS の font-family 値として安全な、引用符つきのファミリー名。
 *
 * ⚠️ 引用符は必須。CSS の識別子は数字で始められないため、
 * `font-family: Rounded Mplus 1c` は `1c` が不正トークンとなり
 * **宣言全体が破棄されて全文字がフォールバックへ落ちる**(無引用でも通る
 * "Yusei Magic" では表面化しなかった)。呼び出し側は
 * `${useDoodleFont()}, ${DOODLE_FONT_STACK}` の形で連結するため、
 * 先頭要素も必ず引用符つきで渡す。
 */
export const DOODLE_FONT_CSS = `"${DOODLE_FONT.family}"`;

/** 契約が指すウェイト。太さを明示したい呼び出し側が使う。 */
export const DOODLE_FONT_WEIGHT: string = DOODLE_FONT.weight;

let fontLoadPromise: Promise<void> | null = null;

/** バンドル内で一度だけ FontFace をロードして document.fonts へ登録する。 */
function loadDoodleFontOnce(): Promise<void> {
  if (fontLoadPromise) return fontLoadPromise;
  fontLoadPromise = (async () => {
    if (typeof document === "undefined" || typeof FontFace === "undefined") {
      return;
    }
    const url = staticFile(DOODLE_FONT.file);
    // 第1引数の名前がそのまま CSS の font-family 参照名になる。
    // DOODLE_FONT.family には TTF の内部ファミリー名を書くこと(style.ts の注記参照)。
    const face = new FontFace(DOODLE_FONT_FAMILY, `url(${url})`, {
      weight: DOODLE_FONT.weight,
      style: "normal",
    });
    await face.load();
    // FontFaceSet.add は環境の DOM lib 定義に無いことがあるため any 経由で呼ぶ
    (document.fonts as unknown as { add: (f: FontFace) => void }).add(face);
  })();
  return fontLoadPromise;
}

/**
 * フォントをロードし、ロード完了まで delayRender で描画を待たせる。
 * 返り値はそのまま `fontFamily` に使える**引用符つき**のファミリ名
 * (FontFace 登録名が要る場合は DOODLE_FONT_FAMILY を使うこと)。
 */
export function useDoodleFont(): string {
  const [handle] = useState(() => delayRender("load-doodle-font"));
  useEffect(() => {
    let alive = true;
    loadDoodleFontOnce()
      .catch(() => {
        // ロードに失敗しても描画は止めない(フォールバックのsans-serifで続行)
      })
      .finally(() => {
        if (alive) continueRender(handle);
      });
    return () => {
      alive = false;
    };
  }, [handle]);
  return DOODLE_FONT_CSS;
}

/** フォールバックを含む font-family 文字列。 */
export const DOODLE_FONT_STACK = `${DOODLE_FONT_CSS}, ${DOODLE_FONT.fallback}`;
