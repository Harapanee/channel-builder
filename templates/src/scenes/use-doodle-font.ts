/**
 * 手描き風日本語フォント "Yusei Magic"(SIL OFL 1.1)のロード。
 *
 * @remotion/google-fonts 等のネットワークロードは使わず、
 * assets/fonts/ に同梱した TTF を staticFile + FontFace + delayRender/continueRender
 * でロードする。字幕(Episode.tsx)と TitleCard / SpeechBubble などで使用する。
 */
import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

export const DOODLE_FONT_FAMILY = "Yusei Magic";

let fontLoadPromise: Promise<void> | null = null;

/** バンドル内で一度だけ FontFace をロードして document.fonts へ登録する。 */
function loadDoodleFontOnce(): Promise<void> {
  if (fontLoadPromise) return fontLoadPromise;
  fontLoadPromise = (async () => {
    if (typeof document === "undefined" || typeof FontFace === "undefined") {
      return;
    }
    const url = staticFile("assets/fonts/YuseiMagic-Regular.ttf");
    const face = new FontFace(DOODLE_FONT_FAMILY, `url(${url})`, {
      weight: "400",
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
 * 返り値はそのまま `fontFamily` に使えるファミリ名。
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
  return DOODLE_FONT_FAMILY;
}

/** フォールバックを含む font-family 文字列。 */
export const DOODLE_FONT_STACK = `"${DOODLE_FONT_FAMILY}", "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif`;
