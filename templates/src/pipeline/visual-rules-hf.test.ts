import assert from "node:assert/strict";
import test from "node:test";
import type { ClipInfo, CompositionDom } from "./composition-dom";
import { evaluateAdviseRules, evaluateBlockRules, sceneClipsOf, type LibraryEntry, type VisualRules } from "./visual-rules-hf";

function clip(id: string, classes: string[], srcs: string[], sig = "aaaaaaaaaaaa"): ClipInfo {
  return {
    id,
    classes,
    trackIndex: classes.includes("scene") ? 1 : 40,
    startSec: 0,
    durationSec: 1,
    images: srcs.map((src) => ({
      src,
      naturalW: 1920,
      naturalH: 1080,
      objectFit: "cover",
      objectPosition: "50% 50%",
    })),
    signature: sig,
  };
}

const LIB: LibraryEntry[] = [
  { assetId: "a1", kind: "place", file: "places/reef.png", source: "public_domain" },
  { assetId: "a2", kind: "place", file: "places/cave.png", source: "public_domain" },
  { assetId: "a3", kind: "character", file: "characters/fish.png", source: "ai_image" },
  { assetId: "a4", kind: "prop", file: "props/net.png", source: "ai_image" },
];

const RULES: VisualRules = {
  sceneClipSelector: ".clip.scene",
  minDurationSec: 60,
  minUniqueImagesPerMin: 2,
  maxUsesPerImage: { default: 3, byKind: { character: null } },
  maxAiRatio: 0.5,
  maxConsecutiveAssetFreeShots: 2,
};

test("sceneClipsOf は字幕clipを除外する", () => {
  const dom: CompositionDom = {
    durationSec: 120,
    clips: [clip("c1", ["clip", "scene"], []), clip("s1", ["subtitle", "clip"], [])],
  };
  const scenes = sceneClipsOf(dom, RULES);
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].id, "c1");
});

test("規則1: ユニーク画像密度が下限未満ならBLOCK", () => {
  const dom: CompositionDom = {
    durationSec: 120, // 2分。下限2枚/分なので4枚必要
    clips: [clip("c1", ["clip", "scene"], ["assets/places/reef.png"])],
  };
  const f = evaluateBlockRules(dom, LIB, RULES).filter((x) => x.rule === "unique-image-density");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "BLOCK");
  assert.match(f[0].message, /0\.5枚\/分/);
});

test("規則2: 同一素材の使用回数超過はBLOCK・kindがnullなら除外", () => {
  const dom: CompositionDom = {
    durationSec: 120,
    clips: [
      clip("c1", ["clip", "scene"], ["assets/props/net.png", "assets/props/net.png"]),
      clip("c2", ["clip", "scene"], ["assets/props/net.png", "assets/props/net.png"]),
      // characterはbyKind:nullで無制限 → 5回使っても検出されない
      clip("c3", ["clip", "scene"], Array(5).fill("assets/characters/fish.png")),
    ],
  };
  const f = evaluateBlockRules(dom, LIB, RULES).filter((x) => x.rule === "max-uses-per-image");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /props\/net\.png/);
  assert.doesNotMatch(f[0].message, /characters\/fish\.png/);
});

test("規則2: 数値形の maxUsesPerImage は全kindへ一律適用(後方互換)", () => {
  const dom: CompositionDom = {
    durationSec: 120,
    clips: [clip("c1", ["clip", "scene"], Array(5).fill("assets/characters/fish.png"))],
  };
  const f = evaluateBlockRules(dom, LIB, { ...RULES, maxUsesPerImage: 3 }).filter(
    (x) => x.rule === "max-uses-per-image"
  );
  assert.equal(f.length, 1);
  assert.match(f[0].message, /characters\/fish\.png/);
});

test("規則3: 素材なしシーンclipの連続超過はBLOCK", () => {
  const dom: CompositionDom = {
    durationSec: 120,
    clips: [
      clip("c1", ["clip", "scene"], []),
      clip("c2", ["clip", "scene"], []),
      clip("c3", ["clip", "scene"], []),
      clip("c4", ["clip", "scene"], ["assets/places/reef.png"]),
    ],
  };
  const f = evaluateBlockRules(dom, LIB, RULES).filter((x) => x.rule === "consecutive-asset-free");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /3連続/);
});

test("規則4: AI比率超過はBLOCK", () => {
  const dom: CompositionDom = {
    durationSec: 120,
    clips: [
      clip("c1", ["clip", "scene"], ["assets/characters/fish.png", "assets/props/net.png"]),
      clip("c2", ["clip", "scene"], ["assets/places/reef.png"]),
    ],
  };
  // ユニーク3枚中AI2枚 = 67% > 50%
  const f = evaluateBlockRules(dom, LIB, RULES).filter((x) => x.rule === "max-ai-ratio");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /67%/);
});

test("規則4: 台帳未登録の素材はBLOCK", () => {
  const dom: CompositionDom = {
    durationSec: 120,
    clips: [clip("c1", ["clip", "scene"], ["assets/places/unknown.png"])],
  };
  const f = evaluateBlockRules(dom, LIB, RULES).filter((x) => x.rule === "unregistered-asset");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /unknown\.png/);
});

test("規則5: 尺が下限未満ならBLOCK", () => {
  const dom: CompositionDom = { durationSec: 30, clips: [clip("c1", ["clip", "scene"], [])] };
  const f = evaluateBlockRules(dom, LIB, RULES).filter((x) => x.rule === "min-duration");
  assert.equal(f.length, 1);
});

test("様式資産(assets/hf・assets/fonts)は素材に数えない", () => {
  const dom: CompositionDom = {
    durationSec: 60,
    clips: [clip("c1", ["clip", "scene"], ["assets/hf/frame.png", "assets/fonts/x.png"])],
  };
  const f = evaluateBlockRules(dom, LIB, RULES);
  assert.equal(f.filter((x) => x.rule === "unregistered-asset").length, 0);
  // 素材ゼロ扱いなので連続空clip側に数えられる
  assert.equal(f.filter((x) => x.rule === "consecutive-asset-free").length, 0); // 1連続なので上限内
});

test("違反が無ければ空配列", () => {
  // 尺60秒(=1分)・ユニーク2枚 → 密度2.0枚/分でちょうど下限を満たす
  const dom: CompositionDom = {
    durationSec: 60,
    clips: [
      clip("c1", ["clip", "scene"], ["assets/places/reef.png"]),
      clip("c2", ["clip", "scene"], ["assets/places/cave.png"]),
      clip("c3", ["clip", "scene"], ["assets/places/reef.png", "assets/places/cave.png"]),
    ],
  };
  assert.deepEqual(evaluateBlockRules(dom, LIB, { ...RULES, maxAiRatio: 1 }), []);
});

test("規則6: 単一シグネチャがシーンclipの2割超を占めるとADVISE", () => {
  const dom: CompositionDom = {
    durationSec: 600,
    clips: [
      clip("c1", ["clip", "scene"], [], "sig-same"),
      clip("c2", ["clip", "scene"], [], "sig-same"),
      clip("c3", ["clip", "scene"], [], "sig-same"),
      clip("c4", ["clip", "scene"], [], "sig-x"),
    ],
  };
  const f = evaluateAdviseRules(dom, RULES, new Map()).filter((x) => x.rule === "template-mass-production");
  assert.equal(f.length, 1);
  assert.equal(f[0].level, "ADVISE");
  assert.match(f[0].message, /実効演出数 2/);
  assert.match(f[0].message, /75%/);
});

test("規則7: 過去epと同じシグネチャがあればADVISE", () => {
  const dom: CompositionDom = {
    durationSec: 600,
    clips: [clip("c1", ["clip", "scene"], [], "sig-old"), clip("c2", ["clip", "scene"], [], "sig-new")],
  };
  const past = new Map([["sig-old", ["ep008-cheetah"]]]);
  const f = evaluateAdviseRules(dom, RULES, past).filter((x) => x.rule === "zero-carryover");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /c1/);
  assert.match(f[0].message, /ep008-cheetah/);
});

test("規則8: 様式clipの比率超過はADVISE", () => {
  const dom: CompositionDom = {
    durationSec: 600,
    clips: [
      clip("c1", ["clip", "scene", "chapter-card"], [], "s1"),
      clip("c2", ["clip", "scene", "chapter-card"], [], "s2"),
      clip("c3", ["clip", "scene"], [], "s3"),
    ],
  };
  const rules: VisualRules = { ...RULES, styleClasses: ["chapter-card"], maxCaptionShotRatio: 0.2 };
  const f = evaluateAdviseRules(dom, rules, new Map()).filter((x) => x.rule === "style-clip-ratio");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /67%/);
});

test("規則9: 縦長素材がobject-position既定のままならADVISE", () => {
  const tall: ClipInfo = {
    id: "c1",
    classes: ["clip", "scene"],
    trackIndex: 1,
    startSec: 0,
    durationSec: 1,
    images: [
      { src: "assets/places/tall.png", naturalW: 800, naturalH: 1200, objectFit: "cover", objectPosition: "50% 50%" },
    ],
    signature: "s1",
  };
  const dom: CompositionDom = { durationSec: 600, clips: [tall] };
  const f = evaluateAdviseRules(dom, { ...RULES, minCoverAspectRatio: 1.3 }, new Map()).filter(
    (x) => x.rule === "tall-image-framing"
  );
  assert.equal(f.length, 1);
  assert.match(f[0].message, /tall\.png/);
});

test("規則9: contain指定または明示のobject-positionなら指摘しない", () => {
  const ok: ClipInfo = {
    id: "c1",
    classes: ["clip", "scene"],
    trackIndex: 1,
    startSec: 0,
    durationSec: 1,
    images: [
      { src: "assets/places/tall.png", naturalW: 800, naturalH: 1200, objectFit: "contain", objectPosition: "50% 50%" },
      { src: "assets/places/tall2.png", naturalW: 800, naturalH: 1200, objectFit: "cover", objectPosition: "50% 20%" },
    ],
    signature: "s1",
  };
  const dom: CompositionDom = { durationSec: 600, clips: [ok] };
  const f = evaluateAdviseRules(dom, { ...RULES, minCoverAspectRatio: 1.3 }, new Map()).filter(
    (x) => x.rule === "tall-image-framing"
  );
  assert.equal(f.length, 0);
});
