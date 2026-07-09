#!/usr/bin/env node
/**
 * channel-builder テンプレート同期チェッカー。
 *
 * SRC(このリポジトリ)とテンプレートの乖離を機械検証する:
 *  - IDENTICAL: 完全一致必須のファイル(パイプライン・コンポーネント基盤等)
 *  - VARIANT:   テンプレ側が意図的に汎用化されたファイル(存在+禁止文字列なしを検査)
 *  - テンプレ全域でチャンネル固有文字列(禁止語)が混入していないこと
 *
 * 実行: node scripts/check-template-sync.mjs   (差異があれば exit 1)
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const SRC = process.cwd();
const TPL = path.join(
  process.env.HOME,
  ".claude/skills/channel-builder/templates"
);
const BUILDER_REPO = path.join(process.env.HOME, ".claude/skills/channel-builder");

// 完全一致必須(SRCが正)
const IDENTICAL = [
  "README.md", // 使い方説明書(汎用マニュアル) — factory-updateで既存Factoryにも配布される
  ".gitignore",
  "tsconfig.json",
  "remotion.config.ts",
  "src/pipeline/tts.ts",
  "src/pipeline/parse-script.ts",
  "src/pipeline/validate-shots.ts",
  "src/pipeline/qa.ts",
  "src/pipeline/qa-smoke.ts",
  "src/pipeline/repair-render.ts",
  "src/pipeline/gen-image.ts",
  "src/pipeline/remove-bg.ts",
  "src/pipeline/retime-shots.ts",
  "src/pipeline/render-thumbs.ts",
  "src/remotion/Root.tsx",
  "src/remotion/Episode.tsx",
  "src/remotion/QASmokeRoot.tsx",
  "src/remotion/Thumbnail.tsx",
  "src/remotion/ThumbRoot.tsx",
  "src/motion/index.ts",
  "src/motion/noise.ts",
  "src/scenes/asset-context.tsx",
  "src/scenes/use-doodle-font.ts",
  "src/scenes/doodle-svg.ts",
  "src/scenes/shared/JapanMap.tsx",
  "src/scenes/shared/WorldMap.tsx",
  "src/scenes/shared/world-geometry.ts",
  "src/scenes/shared/ThreeFaces.tsx",
  "src/scenes/shared/TruckIsekai.tsx",
  "src/scenes/shared/japan-geometry.ts",
  "assets/maps/japan-doodle.svg",
  "scripts/hooks/guard-approved.mjs",
  "scripts/hooks/validate-json.mjs",
  ".claude/settings.json",
  ".claude/agents/publisher.md",
  ".claude/agents/asset-generator.md",
  ".claude/agents/reading-checker.md",
  ".claude/agents/script-reviewer.md",
  ".claude/agents/theme-scout.md",
  ".claude/skills/theme-scout/SKILL.md",
  ".claude/skills/system-refine/SKILL.md",
  ".claude/skills/factory-update/SKILL.md",
  ".claude/skills/render-queue/SKILL.md",
  "scripts/check-template-sync.mjs",
  "scripts/render-episode.sh",
  "scripts/wait-render.sh",
  "scripts/promote-preview.sh",
  "scripts/render-queue.sh",
];

// 意図的な汎用化版(存在+禁止語なしのみ検査)
const VARIANT = [
  "package.json", // name がチャンネルごとに異なる
  "CLAUDE.md",
  ".channel-system.json",
  "channel/bible-template.md",
  "channel/voice-template.json",
  "channel/review-checklist.md",
  ".claude/skills/video-create/SKILL.md",
  ".claude/skills/channel-refine/SKILL.md",
  ".claude/agents/script-director.md",
  ".claude/agents/visual-director.md",
  ".claude/agents/scene-implementer.md",
  ".claude/agents/fact-checker.md",
  ".claude/agents/compliance-reviewer.md",
  ".claude/agents/audience-sim.md",
  "src/scenes/registry.ts",
  "src/scenes/style.ts",
  // 固定アウトロ(既定のチャンネル名・クレジット文字列のみ汎用化した変種)
  "src/scenes/shared/Outro.tsx",
  "assets/library.json",
  // you-modern(トラック転生OPの共有キャラ、存在チェックのみ)
  "assets/characters/you-modern/neutral.png",
  "assets/characters/you-modern/walking-on-phone.png",
  "assets/characters/you-modern/hit-launched.png",
  "assets/characters/you-modern/soul.png",
  "assets/characters/you-modern/canonical.png",
];

// テンプレ全域で禁止のチャンネル固有文字列
const FORBIDDEN = [
  "青山龍星",
  "nobunaga",
  "napoleon",
  "mitsuhide",
  "imagawa",
  "転生したら最悪",
  "reincarnation-hell",
];
// 禁止語検査の除外(docs/はチャンネル事例を含む設計文書のため)
const FORBIDDEN_EXEMPT = [
  "docs/", // 設計文書はチャンネル事例を含む
  "episodes/ep000-test/",
  "README.md", // 使い方説明書は実例(このチャンネル)で説明する方針
  "channel/bible-template.md", // 「> 例(…)」の意図的例示(展開時に置換される)
  "scripts/check-template-sync.mjs", // 自分自身(禁止語リストを内蔵するため。リストは各Factoryが自チャンネル語彙で保守する)
];

let failures = 0;
const fail = (msg) => {
  console.error("NG: " + msg);
  failures++;
};

for (const f of IDENTICAL) {
  const a = path.join(SRC, f);
  const b = path.join(TPL, f);
  if (!fs.existsSync(b)) fail(`IDENTICAL欠落: ${f}`);
  else if (!fs.existsSync(a))
    fail(`IDENTICAL未受領: ${f}(このFactoryに無い — テンプレートからコピーが必要)`);
  else if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8"))
    fail(`IDENTICAL乖離: ${f}(SRCから再コピーが必要)`);
}

for (const f of VARIANT) {
  if (!fs.existsSync(path.join(TPL, f))) fail(`VARIANT欠落: ${f}`);
}

// 禁止語スキャン
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(TPL, p);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p);
    } else {
      if (FORBIDDEN_EXEMPT.some((x) => rel.startsWith(x))) continue;
      if (/\.(png|jpg|jpeg|wav|mp3|mp4|ttf|otf)$/i.test(e.name)) continue;
      const body = fs.readFileSync(p, "utf8");
      for (const w of FORBIDDEN) {
        if (body.toLowerCase().includes(w.toLowerCase()))
          fail(`禁止語「${w}」が ${rel} に混入`);
      }
    }
  }
};
walk(TPL);

// channel-builderのgit push状態を検証(system-refineでの同期漏れ防止)
function checkBuilderRepoPushed() {
  const opts = { cwd: BUILDER_REPO, stdio: ["ignore", "pipe", "pipe"] };
  try {
    execSync("git rev-parse --is-inside-work-tree", opts);
  } catch {
    fail(`channel-builderがgitリポジトリではない: ${BUILDER_REPO}`);
    return;
  }
  const status = execSync("git status --porcelain", opts).toString();
  if (status.trim() !== "") {
    fail("channel-builderに未コミットの変更が残っている(git add -A && git commit が必要)");
  }
  try {
    execSync("git fetch origin", opts);
  } catch (e) {
    fail(`channel-builderのgit fetchに失敗(リモート未設定/認証切れ?): ${e.message}`);
    return;
  }
  const ahead = execSync("git rev-list --count @{u}..HEAD", opts).toString().trim();
  if (ahead !== "0") {
    fail(`channel-builderにpush漏れのコミットが${ahead}件ある(git push が必要)`);
  }
}
checkBuilderRepoPushed();

if (failures === 0) {
  console.log(
    `OK: テンプレート同期は健全(IDENTICAL ${IDENTICAL.length} / VARIANT ${VARIANT.length} / 禁止語 ${FORBIDDEN.length}種スキャン)`
  );
} else {
  console.error(`\n${failures}件の乖離。同期後に再実行すること。`);
}
process.exit(failures === 0 ? 0 : 1);
