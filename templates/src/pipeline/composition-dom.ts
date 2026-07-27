/**
 * composition.html を headless Chrome で評価し、実DOMから clip と画像使用を収集する。
 *
 * composition.html はシーンの中身を JavaScript で document.createElement して
 * 組み立てるため、静的HTMLのパースでは <img> が1件も取れない(実エピソードで実測)。
 * ブラウザ本体は hyperframes が同梱する chrome-headless-shell を流用し、
 * 追加ダウンロードを発生させない。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

export type ImageUse = {
  /** プロジェクトルート基準の相対パス(例: assets/places/reef.png) */
  src: string;
  naturalW: number;
  naturalH: number;
  objectFit: string;
  objectPosition: string;
};

export type ClipInfo = {
  id: string | null;
  classes: string[];
  /** clip配下(自身は含まない)に現れる全クラスをユニーク化・昇順ソートしたもの */
  descendantClasses: string[];
  trackIndex: number | null;
  startSec: number;
  durationSec: number;
  images: ImageUse[];
  /** 構造シグネチャ(タグ+クラス)とモーション指紋を連結したもの: "<構造>:<モーション>" */
  signature: string;
};

export type CompositionDom = {
  durationSec: number;
  clips: ClipInfo[];
};

/**
 * <base> タグを挿入する。
 * <head> はHTML5では省略可能なので、無い場合もフォールバックして必ず挿入する
 * (実装者が自由な形のHTMLを書いても検査が実行エラーで落ちないようにするため)。
 * 置換文字列に $ が含まれても壊れないよう、関数形式の replace を使う。
 */
export function injectBase(raw: string, baseHref: string): string {
  const tag = `<base href="${baseHref}">`;
  if (/<head([^>]*)>/i.test(raw)) return raw.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${tag}`);
  if (/<html([^>]*)>/i.test(raw)) return raw.replace(/<html([^>]*)>/i, (_m, attrs) => `<html${attrs}><head>${tag}</head>`);
  return `<head>${tag}</head>${raw}`;
}

/**
 * 1回の check:visual で最大4つのcomposition(現行ep+過去ep3本)を開くため、
 * npx の解決を毎回走らせない。プロセス内でのみ有効。
 */
let cachedChromePath: string | null = null;

/** hyperframes が管理する Chrome の実行パスを得る */
export function resolveChromePath(projectRoot: string): string {
  if (cachedChromePath !== null) return cachedChromePath;
  const out = execFileSync(
    "npx",
    ["--yes", "hyperframes@0.7.68", "browser", "path"],
    { cwd: projectRoot, encoding: "utf8" }
  );
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("/"));
  if (!line) {
    throw new Error(
      "hyperframes browser path が実行パスを返しませんでした。`npx hyperframes browser ensure` を先に実行してください"
    );
  }
  cachedChromePath = line;
  return line;
}

export async function collectCompositionDom(
  compositionPath: string,
  projectRoot: string
): Promise<CompositionDom> {
  const chromePath = resolveChromePath(projectRoot);

  // ルート基準の相対パス(assets/...)を解決させるため <base> を注入する。
  // pathToFileURL でURL化するのは、パスに空白・#・? が含まれても壊れないようにするため。
  const rootUrl = pathToFileURL(projectRoot).href.replace(/\/?$/, "/");
  const html = injectBase(readFileSync(compositionPath, "utf8"), rootUrl);

  // NOTE: page.setContent() は使わない(brief記載のコードから変更)。
  // 理由: page.setContent() で流し込んだ文書のoriginは file:// にならず、Chromeが
  // 「Not allowed to load local resource」としてローカル画像の読み込みを拒否する
  // (実測済み。<base href="file://...">を注入しても効果なし)。file://で実際に
  // navigateした文書からは <base> 経由のクロスディレクトリ相対パスも問題なく解決される
  // (実測済み)ため、一時HTMLファイルへ書き出して page.goto("file://...") で開く。
  // NOTE: tmpDir の削除は最も外側の finally に置く(fix round 1で指摘・修正)。
  // 理由: chromium.launch() や browser.close() が例外を投げるケース(実行パス不正・
  // リソース枯渇など)でも、tmpDir の後始末だけは必ず走らせるため。ブラウザの
  // close() はその内側の finally に残し、close が投げてもtmpDir削除には到達する。
  const tmpDir = mkdtempSync(path.join(tmpdir(), "hf-composition-dom-"));
  try {
    const tmpHtmlPath = path.join(tmpDir, "eval.html");
    writeFileSync(tmpHtmlPath, html);

    const browser = await chromium.launch({ executablePath: chromePath });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(pathToFileURL(tmpHtmlPath).href, { waitUntil: "load" });
      // GSAP登録とJS組み立てが終わるまで待つ(157clip規模の実エピソードで1.5秒で確定することを実測)
      await page.waitForTimeout(1500);

      // NOTE: このブロックは page.evaluate() に「文字列」として渡す(アロー関数リテラルとして渡さない)。
      // 理由: tsx(esbuild)の変換はデフォルトで keepNames:true が有効で、ファイル内の名前付き関数/constを
      // 例外なく __name(fn, "fn") 呼び出しでラップする。page.evaluate() にアロー関数を直接渡すと
      // Playwright は toString() でソースを取り出してブラウザ側で実行するが、__name はNode側モジュール
      // スコープにしか存在しないため、ブラウザ実行時に ReferenceError: __name is not defined になる
      // (実測済み)。文字列として渡せば tsx はその中身をASTとして解析しないため __name が注入されず、
      // ブラウザにも問題なく渡る。briefのロジック(structureOf/hash12/収集内容)は変更していない。
      return await page.evaluate(`(() => {
        function structureOf(el, depth) {
          if (depth === undefined) depth = 0;
          if (depth > 4) return [];
          var self = el.tagName.toLowerCase() + "." + [...el.classList].sort().join(".");
          var out = [self];
          for (var c of el.children) out.push(...structureOf(c, depth + 1));
          return out;
        }
        function hash12(s) {
          var h1 = 0x811c9dc5, h2 = 0x01000193;
          for (var i = 0; i < s.length; i++) {
            h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
            h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0;
          }
          return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
        }

        // 素材の収集は要素の種類ではなく「ブラウザが解決した絶対URL」を一次情報にする。
        // <img> 決め打ちだと background-image / SVG <image> / "./" 相対が取れず、
        // 実素材で作った映像が「素材ゼロ」と判定されてしまうため(実測で確認済み)。
        var BASE = document.baseURI;
        function toRel(u) {
          if (!u) return "";
          var abs;
          try { abs = new URL(u, BASE).href; } catch (e) { return ""; }
          if (abs.indexOf(BASE) !== 0) return "";  // data: と外部URLはここで落ちる
          var rel = abs.slice(BASE.length);
          try { return decodeURIComponent(rel); } catch (e) { return rel; }
        }
        function cssUrls(v) {
          if (!v || v === "none") return [];
          var out = [], re = /url\\((['"]?)(.*?)\\1\\)/g, m;
          while ((m = re.exec(v)) !== null) out.push(m[2]);
          return out;
        }
        function imagesIn(clipEl) {
          var out = [];
          var els = [clipEl].concat([...clipEl.querySelectorAll("*")]);
          for (var el of els) {
            var tag = el.tagName.toLowerCase();
            if (tag === "img") {
              var cs = getComputedStyle(el);
              out.push({
                src: toRel(el.currentSrc || el.getAttribute("src") || ""),
                naturalW: el.naturalWidth, naturalH: el.naturalHeight,
                objectFit: cs.objectFit, objectPosition: cs.objectPosition
              });
              continue;
            }
            if (tag === "image") {  // SVG <image>。実寸は取れないので規則9の対象外になる
              out.push({
                src: toRel(el.getAttribute("href") || el.getAttribute("xlink:href") || ""),
                naturalW: 0, naturalH: 0, objectFit: "", objectPosition: ""
              });
              continue;
            }
            var s = getComputedStyle(el);
            var urls = cssUrls(s.backgroundImage)
              .concat(cssUrls(s.maskImage), cssUrls(s.webkitMaskImage), cssUrls(s.borderImageSource));
            for (var u of urls) {
              out.push({ src: toRel(u), naturalW: 0, naturalH: 0, objectFit: "", objectPosition: "" });
            }
          }
          return out.filter(function (x) { return x.src !== ""; });
        }

        // GSAPの制御用キー。これらを除いた残りが「何をアニメさせたか」になる
        var GSAP_CONTROL = {
          delay:1, duration:1, ease:1, overwrite:1, parent:1, repeat:1, repeatDelay:1,
          yoyo:1, yoyoEase:1, immediateRender:1, startAt:1, stagger:1, paused:1,
          id:1, data:1, inherit:1, lazy:1, callbackScope:1, keyframes:1, runBackwards:1,
          onComplete:1, onStart:1, onUpdate:1, onRepeat:1, onReverseComplete:1
        };
        function easeName(e) {
          if (!e) return "none";
          if (typeof e === "string") return e;
          if (typeof e === "function") return e.name || "custom";
          return String(e.name || "custom");
        }
        /**
         * clipごとのモーション指紋。構造(タグ+クラス)だけのシグネチャでは、
         * 同じDOMに違う動きを付けた演出が「1演出」に潰れて量産扱いされるため、
         * アニメプロパティ・ease・尺を指紋にして構造と連結する。
         * GSAPが読めない/tweenが無い場合は空文字を返し、従来挙動へ縮退する。
         */
        function motionHashes(clipEls) {
          var idx = new Map();
          for (var n = 0; n < clipEls.length; n++) idx.set(clipEls[n], n);
          var acc = clipEls.map(function () { return []; });
          var tls = window.__timelines || {};
          for (var key of Object.keys(tls)) {
            var tl = tls[key];
            if (!tl || typeof tl.getChildren !== "function") continue;
            var kids;
            try { kids = tl.getChildren(true, true, true) || []; } catch (e) { continue; }
            for (var t of kids) {
              if (!t || typeof t.targets !== "function") continue;
              var props = Object.keys(t.vars || {})
                .filter(function (p) { return !GSAP_CONTROL[p]; })
                .sort()
                .join(",");
              var dur = 0;
              try { dur = Math.round((t.duration() || 0) * 10) / 10; } catch (e) { dur = 0; }
              var fp = props + "|" + easeName(t.vars && t.vars.ease) + "|" + dur;
              var tgs;
              try { tgs = t.targets() || []; } catch (e) { continue; }
              for (var g of tgs) {
                if (!g || typeof g.closest !== "function") continue;
                var owner = g.closest(".clip");
                if (!owner || !idx.has(owner)) continue;
                acc[idx.get(owner)].push(fp);
              }
            }
          }
          return acc.map(function (list) {
            return list.length ? hash12([...new Set(list)].sort().join(";")) : "";
          });
        }

        var root = document.querySelector("[data-composition-id]");
        var durationSec = parseFloat(root?.getAttribute("data-duration") || "0");

        var clipEls = [...document.querySelectorAll(".clip")];
        var motion = motionHashes(clipEls);

        var clips = clipEls.map((c, ci) => {
          var images = imagesIn(c);
          var trackRaw = c.getAttribute("data-track-index");
          return {
            id: c.id || null,
            classes: [...c.classList],
            descendantClasses: [...new Set([].concat.apply([], [...c.querySelectorAll("*")].map(function (e) { return [...e.classList]; })))].sort(),
            trackIndex: trackRaw === null ? null : Number(trackRaw),
            startSec: parseFloat(c.getAttribute("data-start") || "0"),
            durationSec: parseFloat(c.getAttribute("data-duration") || "0"),
            images,
            signature: hash12(structureOf(c).slice(0, 200).join(">")) + ":" + motion[ci],
          };
        });

        return { durationSec, clips };
      })()`) as unknown as CompositionDom;
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
