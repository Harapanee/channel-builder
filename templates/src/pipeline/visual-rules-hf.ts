/**
 * HyperFrames経路の視覚多様性検査(純関数)。
 *
 * 旧 Remotion 経路では shots.json を入力に validate-shots.ts が同等の検査をしていた。
 * shots.json 廃止に伴い、評価済みDOM(composition-dom.ts)を入力に作り直したもの。
 * I/O を一切持たないため単体テストが速い。
 */
import type { ClipInfo, CompositionDom } from "./composition-dom";

export type Finding = { level: "BLOCK" | "ADVISE"; rule: string; message: string };

export type LibraryEntry = {
  assetId: string;
  kind: string;
  /** assets/ からの相対パス(例: places/reef.png) */
  file: string;
  source: string;
};

export type VisualRules = {
  /** シーンclipの識別。既定 ".clip.scene" */
  sceneClipSelector?: string;
  /** 反復が正当な様式クラス(章カード・クレジット等) */
  styleClasses?: string[];
  minDurationSec?: number;
  minUniqueImagesPerMin?: number;
  /** 数値=全kind一律(後方互換) / オブジェクト=kind別(nullは無制限) */
  maxUsesPerImage?: number | { default: number; byKind?: Record<string, number | null> };
  maxAiRatio?: number;
  maxConsecutiveAssetFreeShots?: number;
  minCoverAspectRatio?: number;
  maxCaptionShotRatio?: number;
};

/** AI生成と見なす library.json の source 値 */
const AI_SOURCES = new Set(["ai_image", "ai"]);

/** 素材に数えない(様式資産)パスの接頭辞 */
const NON_ASSET_PREFIXES = ["assets/hf/", "assets/fonts/"];

/** 素材として数える画像srcか(CLIヘッダの表示数もこれで揃える。M2) */
export function isCountedAsset(src: string): boolean {
  if (!src.startsWith("assets/")) return false;
  return !NON_ASSET_PREFIXES.some((p) => src.startsWith(p));
}

/**
 * sceneClipSelector(".clip.scene" 形式)から必要クラスを取り出してフィルタする。
 * CSSセレクタの全機能は解釈しない — クラス列挙のみを解釈する。
 */
export function sceneClipsOf(dom: CompositionDom, rules: VisualRules): ClipInfo[] {
  const sel = rules.sceneClipSelector ?? ".clip.scene";
  const need = sel.split(".").filter(Boolean);
  return dom.clips.filter((c) => need.every((n) => c.classes.includes(n)));
}

function limitForKind(
  rules: VisualRules,
  kind: string | undefined
): number | null {
  const m = rules.maxUsesPerImage;
  if (m === undefined) return null;
  if (typeof m === "number") return m;
  if (kind !== undefined && m.byKind && kind in m.byKind) return m.byKind[kind];
  return m.default;
}

export function evaluateBlockRules(
  dom: CompositionDom,
  library: LibraryEntry[],
  rules: VisualRules
): Finding[] {
  const findings: Finding[] = [];
  const scenes = sceneClipsOf(dom, rules);
  const byFile = new Map(library.map((a) => [a.file, a]));
  const entryOf = (src: string) => byFile.get(src.replace(/^assets\//, ""));

  const uses = scenes.flatMap((c) => c.images.map((i) => i.src)).filter(isCountedAsset);
  const unique = [...new Set(uses)];

  // 規則5: 尺
  if (rules.minDurationSec !== undefined && dom.durationSec < rules.minDurationSec) {
    findings.push({
      level: "BLOCK",
      rule: "min-duration",
      message: `尺が ${dom.durationSec.toFixed(2)}秒 です(下限 ${rules.minDurationSec}秒)`,
    });
  }

  // 規則1: ユニーク画像密度
  if (rules.minUniqueImagesPerMin !== undefined && dom.durationSec > 0) {
    const perMin = unique.length / (dom.durationSec / 60);
    if (perMin < rules.minUniqueImagesPerMin) {
      findings.push({
        level: "BLOCK",
        rule: "unique-image-density",
        message: `ユニーク画像密度が ${perMin.toFixed(1)}枚/分 です(ユニーク${unique.length}枚 / ${(dom.durationSec / 60).toFixed(1)}分。下限 ${rules.minUniqueImagesPerMin}枚/分)`,
      });
    }
  }

  // 規則4a: 台帳未登録
  const unregistered = unique.filter((u) => !entryOf(u));
  if (unregistered.length > 0) {
    findings.push({
      level: "BLOCK",
      rule: "unregistered-asset",
      message: `assets/library.json に未登録の素材が ${unregistered.length}件 あります: ${unregistered.join(", ")}`,
    });
  }

  // 規則2: 同一素材の使用回数(kind別)
  const counts = new Map<string, number>();
  for (const u of uses) counts.set(u, (counts.get(u) ?? 0) + 1);
  const over: string[] = [];
  for (const [src, n] of counts) {
    const limit = limitForKind(rules, entryOf(src)?.kind);
    if (limit !== null && limit !== undefined && n > limit) over.push(`${src}(${n}回 / 上限${limit}回)`);
  }
  if (over.length > 0) {
    findings.push({
      level: "BLOCK",
      rule: "max-uses-per-image",
      message: `同一素材の使用回数が上限を超えています: ${over.join(", ")}`,
    });
  }

  // 規則3: 素材なしシーンclipの連続
  if (rules.maxConsecutiveAssetFreeShots !== undefined) {
    let run = 0;
    let maxRun = 0;
    let worstEnd = -1;
    scenes.forEach((c, idx) => {
      if (c.images.filter((i) => isCountedAsset(i.src)).length === 0) {
        run++;
        if (run > maxRun) {
          maxRun = run;
          worstEnd = idx;
        }
      } else {
        run = 0;
      }
    });
    if (maxRun > rules.maxConsecutiveAssetFreeShots) {
      const from = scenes[worstEnd - maxRun + 1]?.id ?? "?";
      const to = scenes[worstEnd]?.id ?? "?";
      findings.push({
        level: "BLOCK",
        rule: "consecutive-asset-free",
        message: `素材なしのシーンclipが ${maxRun}連続 しています(${from}〜${to}。上限 ${rules.maxConsecutiveAssetFreeShots}連続)`,
      });
    }
  }

  // 規則4b: AI比率(ユニーク素材ベース。台帳未登録は分母から外す)
  if (rules.maxAiRatio !== undefined) {
    const known = unique.map(entryOf).filter((a): a is LibraryEntry => Boolean(a));
    if (known.length > 0) {
      const ai = known.filter((a) => AI_SOURCES.has(a.source)).length;
      const ratio = ai / known.length;
      if (ratio > rules.maxAiRatio) {
        findings.push({
          level: "BLOCK",
          rule: "max-ai-ratio",
          message: `AI生成画像がユニーク${known.length}枚中 ${ai}枚(${Math.round(ratio * 100)}%)です(上限 ${Math.round(rules.maxAiRatio * 100)}%)`,
        });
      }
    }
  }

  return findings;
}

/**
 * 構造シグネチャ系の検査。様式クラスの正当な反復と区別しきれないため
 * すべて ADVISE(exit 0 のまま警告)に置く。実データを溜めてから
 * BLOCK 昇格を検討する。
 */
export function evaluateAdviseRules(
  dom: CompositionDom,
  rules: VisualRules,
  pastSignatures: Map<string, string[]>
): Finding[] {
  const findings: Finding[] = [];
  const scenes = sceneClipsOf(dom, rules);
  if (scenes.length === 0) return findings;

  // 規則6: 実効演出数(同一シグネチャ群を1演出と数える)
  const bySig = new Map<string, string[]>();
  for (const c of scenes) {
    const list = bySig.get(c.signature) ?? [];
    list.push(c.id ?? "(id無し)");
    bySig.set(c.signature, list);
  }
  const biggest = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const share = biggest[1].length / scenes.length;
  if (share > 0.2) {
    findings.push({
      level: "ADVISE",
      rule: "template-mass-production",
      message: `シーンclip ${scenes.length}個に対し実効演出数 ${bySig.size}。最大のシグネチャ群が ${biggest[1].length}個(${Math.round(share * 100)}%)を占めます: ${biggest[1].slice(0, 8).join(", ")}`,
    });
  }

  // 規則7: ゼロ持ち越し(過去epと同一シグネチャ)
  const carried = scenes
    .filter((c) => pastSignatures.has(c.signature))
    .map((c) => `${c.id ?? "(id無し)"}→${pastSignatures.get(c.signature)!.join("/")}`);
  if (carried.length > 0) {
    findings.push({
      level: "ADVISE",
      rule: "zero-carryover",
      message: `過去エピソードと同一構造のシーンclipが ${carried.length}件 あります: ${carried.slice(0, 10).join(", ")}`,
    });
  }

  // 規則8: 様式clipの比率
  const styleClasses = rules.styleClasses ?? [];
  if (styleClasses.length > 0 && rules.maxCaptionShotRatio !== undefined) {
    const styled = scenes.filter((c) => c.classes.some((cl) => styleClasses.includes(cl)));
    const ratio = styled.length / scenes.length;
    if (ratio > rules.maxCaptionShotRatio) {
      findings.push({
        level: "ADVISE",
        rule: "style-clip-ratio",
        message: `様式clipがシーンclipの ${Math.round(ratio * 100)}%(${styled.length}/${scenes.length})を占めます(上限 ${Math.round(rules.maxCaptionShotRatio * 100)}%)`,
      });
    }
  }

  // 規則9: 縦長素材のフレーミング未指定
  if (rules.minCoverAspectRatio !== undefined) {
    const bad = new Set<string>();
    for (const c of scenes) {
      for (const img of c.images) {
        if (!isCountedAsset(img.src)) continue;
        if (img.naturalW === 0 || img.naturalH === 0) continue;
        const ar = img.naturalW / img.naturalH;
        if (ar >= rules.minCoverAspectRatio) continue;
        const isDefaultPos = /^50%\s+50%$/.test(img.objectPosition.trim());
        if (img.objectFit === "cover" && isDefaultPos) bad.add(img.src);
      }
    }
    if (bad.size > 0) {
      findings.push({
        level: "ADVISE",
        rule: "tall-image-framing",
        message: `縦長素材が object-fit:cover かつ object-position 既定のまま使われています(主対象が切れる恐れ。fit:contain か object-position の明示を検討): ${[...bad].join(", ")}`,
      });
    }
  }

  return findings;
}
