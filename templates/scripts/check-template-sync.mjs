#!/usr/bin/env node
/**
 * channel-builder テンプレート同期チェッカー。
 *
 * SRC(このリポジトリ)とテンプレートの乖離を機械検証する:
 *  - IDENTICAL: 完全一致必須のファイル(パイプライン・コンポーネント基盤等)
 *  - VARIANT:   テンプレ側が意図的に汎用化されたファイル(存在+禁止文字列なしを検査)
 *  - HF_IDENTICAL: HyperFrames経路のファイル。renderEngine が "hyperframes" のチャンネルでのみ完全一致必須
 *  - テンプレ全域でチャンネル固有文字列(禁止語)が混入していないこと
 *
 * 意図的な不採用の宣言(.channel-system.json):
 *  - templateOptOut: 工程・部品ごと廃止したファイル(SRC側の検査を免除)
 *  - hfOptOut:       HF部品の不採用
 *  - coreOverrides:  コアコンポーネントの再スキン
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
  "src/pipeline/lint-script.ts",
  "src/pipeline/qa.ts",
  "src/pipeline/qa-smoke.ts",
  "src/pipeline/precheck.ts",
  "src/pipeline/render-stills.ts",
  "src/pipeline/repair-render.ts",
  "src/pipeline/gen-image.ts",
  "src/pipeline/codex-image.ts",
  "src/pipeline/remove-bg.ts",
  "src/pipeline/retime-shots.ts",
  "src/pipeline/render-thumbs.ts",
  "src/pipeline/thumb-metrics.ts",
  "src/schemas/thumb-metrics.schema.json",
  "docs/thumbnail-principles.md",
  "src/remotion/Root.tsx",
  "src/remotion/Episode.tsx",
  "src/remotion/QASmokeRoot.tsx",
  "src/remotion/ThumbRoot.tsx",
  "src/motion/index.ts",
  "src/motion/noise.ts",
  "src/scenes/asset-context.tsx",
  "src/scenes/use-doodle-font.ts",
  "src/scenes/doodle-svg.ts",
  // 立ち絵+口パク+表情レイヤー(Episode.tsx が無条件に import する。
  // 描画するかはチャンネルの style.ts が SPEAKER_STANDS を持つかで決まる)
  "src/scenes/shared/SpeakerStands.tsx",
  // 常設セット背景(Episode.tsx が無条件に import する。
  // 描画するかはチャンネルの style.ts が SET_BACKDROP を持つかで決まる)
  "src/scenes/shared/SetBackdrop.tsx",
  "src/scenes/shared/JapanMap.tsx",
  "src/scenes/shared/WorldMap.tsx",
  "src/scenes/shared/world-geometry.ts",
  "src/scenes/shared/ThreeFaces.tsx",
  "src/scenes/shared/TruckIsekai.tsx",
  "src/scenes/shared/LegendBoard.tsx",
  "src/scenes/shared/japan-geometry.ts",
  "assets/maps/japan-doodle.svg",
  "scripts/hooks/guard-approved.mjs",
  "scripts/hooks/validate-json.mjs",
  ".claude/settings.json",
  ".claude/agents/reading-checker.md",
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
  "src/schemas/short.schema.json",
  "src/schemas/short-format.schema.json",
  "src/schemas/types.ts",
  "src/schemas/timing.schema.json",
  "src/schemas/shots.schema.json",
  "src/schemas/episode.schema.json",
  "src/pipeline/validate-short-format.ts",
  "src/pipeline/validate-metadata.ts",
  "src/pipeline/validate-ledger.ts",
  "src/pipeline/finalize-episode.ts",
  // 2026-08-01 追加(コスト・並列度の実測。全経路で使う)
  "src/pipeline/usage-report.ts",
  "src/pipeline/usage-report.test.ts",
  // 2026-08-02 追加(HFエントリの切替。shorts でも使う)
  "src/pipeline/use-episode.ts",
  "src/pipeline/use-episode.test.ts",
  "src/schemas/metadata.schema.json",
  "src/schemas/episode-ledger.schema.json",
  // 2026-09-05 追加(誤読リスクの機械抽出・「次に見る」選定。経路非依存)
  "src/pipeline/check-readings.ts",
  "src/pipeline/next-videos.ts",
  "src/pipeline/next-videos.test.ts",
  "src/schemas/thumb-test.schema.json",
  "src/schemas/analytics.schema.json",
  "src/scenes/shorts/core/RankCard.tsx",
  "src/scenes/shorts/core/ShortTitleCard.tsx",
  ".claude/skills/short-builder/SKILL.md",
  ".claude/skills/short-create/SKILL.md",
  "shorts/sh000-test/short.json",
  "shorts/sh000-test/shots.json",
  "shorts/sh000-test/timing.json",
];

// HyperFrames経路のファイル(本編)。renderEngine が "hyperframes" のチャンネルでのみ
// 完全一致必須。Remotionのままのチャンネルでは存在しなくてよい
// (移行は各チャンネルの /factory-update の判断に委ねる)。
// テンプレ側には必ず存在しなければならない(scaffold元なので欠落は常にNG)。
const HF_IDENTICAL = [
  "hyperframes.json",
  "assets/hf/hf-helpers.js",
  "src/pipeline/scaffold-composition.ts",
  "src/pipeline/composition-dom.ts",
  "src/pipeline/composition-dom.test.ts",
  "src/pipeline/visual-rules-hf.ts",
  "src/pipeline/visual-rules-hf.test.ts",
  "src/pipeline/check-composition.ts",
  // 2026-08-01 追加(ep012 の無音・白画面・素材逸脱の再発防止)
  "src/pipeline/audio-mix.ts",
  "src/pipeline/check-audio.ts",
  "src/pipeline/check-audio.test.ts",
  "src/pipeline/check-storyboard-assets.ts",
  "src/pipeline/check-storyboard-assets.test.ts",
  "src/pipeline/qa-flat-frames.ts",
  "src/pipeline/qa-flat-frames.test.ts",
  // 2026-08-01 追加(snapshot が完成尺の composition で動かない問題の恒久対策)
  "src/pipeline/probe-frames.ts",
  "src/pipeline/probe-frames.test.ts",
  // 2026-08-01 追加(章グループ被覆の検証・SEキューの機械生成・ミックスの契約テスト)
  "src/pipeline/scaffold-composition.test.ts",
  "src/pipeline/audio-mix.test.ts",
  "src/pipeline/build-audio-cues.ts",
  "src/pipeline/build-audio-cues.test.ts",
  // 2026-08-02 追加(BGM包絡線の契約化・共有装置のAPI抽出)
  "src/pipeline/build-bgm-cues.ts",
  "src/pipeline/build-bgm-cues.test.ts",
  "src/pipeline/frag-api.ts",
  "src/pipeline/frag-api.test.ts",
  "src/schemas/bgm-plan.schema.json",
];

// MiniMax H3(生成動画)経路のファイル(本編)。.channel-system.json に h3Pipeline が
// 宣言されたチャンネルでのみ完全一致必須。宣言の無いチャンネルでは存在しなくてよい。
// テンプレ側には必ず存在しなければならない(scaffold元)。2026-09-05 追加
const H3_IDENTICAL = [
  "src/pipeline/h3/ambient.ts",
  "src/pipeline/h3/ambient.test.ts",
  "src/pipeline/h3/assemble.ts",
  "src/pipeline/h3/assemble.test.ts",
  "src/pipeline/h3/build-ambient.ts",
  "src/pipeline/h3/build-audio-cues-h3.ts",
  "src/pipeline/h3/build-audio-cues-h3.test.ts",
  "src/pipeline/h3/build-cuts.ts",
  "src/pipeline/h3/build-cuts.test.ts",
  "src/pipeline/h3/calibrate.ts",
  "src/pipeline/h3/check-first-worst.test.ts",
  "src/pipeline/h3/check-h3-prompt.ts",
  "src/pipeline/h3/check.ts",
  "src/pipeline/h3/check.test.ts",
  "src/pipeline/h3/clip-metrics.ts",
  "src/pipeline/h3/clip-metrics.test.ts",
  "src/pipeline/h3/compose.ts",
  "src/pipeline/h3/compose.test.ts",
  "src/pipeline/h3/config.ts",
  "src/pipeline/h3/figures.ts",
  "src/pipeline/h3/figures.test.ts",
  "src/pipeline/h3/frames.ts",
  "src/pipeline/h3/frames.test.ts",
  "src/pipeline/h3/inspect-clips.ts",
  "src/pipeline/h3/inspect-clips.test.ts",
  "src/pipeline/h3/plan.ts",
  "src/pipeline/h3/plan.test.ts",
  "src/pipeline/h3/pod.ts",
  "src/pipeline/h3/pod.test.ts",
  "src/pipeline/h3/preview-chapter.ts",
  "src/pipeline/h3/preview-chapter.test.ts",
  "src/pipeline/h3/reject-clips.ts",
  "src/pipeline/h3/render-figures.ts",
  "src/pipeline/h3/render-figures.test.ts",
  "src/pipeline/h3/render-subs.py",
  "src/pipeline/h3/run-chapter.ts",
  "src/pipeline/h3/run-chapter.test.ts",
  "src/pipeline/h3/types.ts",
  "src/pipeline/h3/vocab.test.ts",
  "src/schemas/h3-ambient.schema.json",
  "tsconfig.h3.json",
  // 語彙帳の雛形(vocab.test.ts が読む。題材ごとの語彙帳 h3/vocab/<epId>.ts はこれを写して起こす)
  "h3/vocab/example-salmon.ts",
  ".claude/agents/h3-cut-planner.md",
  ".claude/agents/h3-prompt-writer.md",
  ".claude/agents/h3-prompt-reviewer.md",
  ".claude/agents/h3-fix-writer.md",
  ".claude/agents/h3-clip-inspector.md",
  ".claude/agents/figure-planner.md",
  "docs/superpowers/specs/2026-08-19-h3-prompt-pipeline-design.md",
  "docs/superpowers/specs/2026-08-24-h3-pipeline-improvements-design.md",
  "docs/superpowers/specs/2026-09-04-h3-figure-overlay-design.md",
];

// コアコンポーネント(src/scenes/core/)— 原則IDENTICAL(テンプレと完全一致)。
// チャンネル固有の再スキン(props契約互換が条件)は、そのチャンネルの
// .channel-system.json の coreOverrides: string[] に列挙すると存在チェックのみに緩和される。
const CORE_IDENTICAL = [
  "src/scenes/core/ComparisonSplit.tsx",
  "src/scenes/core/DangerCircle.tsx",
  "src/scenes/core/DoodleCharacter.tsx",
  "src/scenes/core/DoodleMap.tsx",
  "src/scenes/core/PlaceholderBase.tsx",
  "src/scenes/core/SpeechBubble.tsx",
  "src/scenes/core/TitleCard.tsx",
];

// VARIANTのうちテンプレ専用ファイル(scaffold時に別名で展開されるためSRC側に存在しない)
const VARIANT_TEMPLATE_ONLY = [
  "channel/bible-template.md", // 展開後は channel/bible.md
  "channel/voice-template.json", // 展開後は channel/voice.json
  // HF未移行chには存在しないため、テンプレ側にのみ存在すればよい扱いにする
  "assets/hf/style-template.css", // 展開後は assets/hf/<slug>-style.css
  "channel/visual-rules.example.json", // 展開後は channel/visual-rules.json
  "assets/hf/README.md",
  // 検査対象の src/motion/index.ts が IDENTICAL(全chバイト一致)なので、
  // テンプレで1回テストすれば全chぶんの担保になる。チャンネル側への配布は不要
  "src/motion/index.test.ts",
];

// 意図的な汎用化版(存在+禁止語なしのみ検査)
const VARIANT = [
  "package.json", // name がチャンネルごとに異なる
  // サムネ構造は bible §13 のチャンネル教義そのもの(例: 中央主人公+矢印 / 1枚絵+帯文字)。
  // コアコンポーネントと同格のチャンネル可変とし、テンプレ版はDoodle系の参照実装
  "src/remotion/Thumbnail.tsx",
  // 画像生成のプロンプト技法は映像スタイル(bible §8)に従属する(グリーンバック/フルフレーム等)。
  // visual-director / scene-implementer と同じ理由でチャンネル適合版を許容する
  ".claude/agents/asset-generator.md",
  // サムネの構造型・言語規則は bible §13 のチャンネル教義に従属する(Thumbnail.tsx と同じ理由)。
  // 参照チャンネル分析に基づくレイアウト型等のチャンネル適合版を許容する
  ".claude/agents/publisher.md",
  // 約束(サムネ・タイトル)の回収位置は bible §4 の構成教義に従属する(2026-07-16:
  // 転生系chは「0〜30秒回収」不適用で冒頭から一生を時系列進行。テンプレ版は中立の参照実装)
  ".claude/agents/script-reviewer.md",
  "docs/retention-principles.md",
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
  ".claude/agents/short-director.md",
  "src/scenes/registry.ts",
  "src/scenes/style.ts",
  // HF共通様式。scaffold時に <slug>-style.css へ改名し bible §8 の実値で埋める
  "assets/hf/style-template.css",
  // 上記のクラス台帳(用途と使用規則の正)。展開後も同名で残り、チャンネル固有の台帳へ書き換わる
  "assets/hf/README.md",
  // 視覚多様性の設定はチャンネル単位(PD主体/AI主体で適正値が異なる)
  "channel/visual-rules.example.json",
  // 検査対象の src/motion/index.ts が IDENTICAL(全chバイト一致)なので、
  // テンプレで1回テストすれば全chぶんの担保になる。チャンネル側への配布は不要
  "src/motion/index.test.ts",
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

let channelSystem = {};
try {
  channelSystem = JSON.parse(
    fs.readFileSync(path.join(SRC, ".channel-system.json"), "utf8")
  );
} catch {}

// 工程・部品の意図的な廃止。そのチャンネルが「この仕組みを運用しない」と決めた場合に
// .channel-system.json の templateOptOut: string[] へパスを列挙すると、そのファイルは
// SRC側で未受領でも乖離でもNGにしない(hfOptOut / coreOverrides と同じ思想)。
// 例: 台本審査・準拠レビューのエージェントを廃止したチャンネル。
// 「テンプレ側に存在すること」の検査だけは opt-out できない(scaffold元のため)。
const templateOptOut = channelSystem.templateOptOut ?? [];

for (const f of IDENTICAL) {
  const a = path.join(SRC, f);
  const b = path.join(TPL, f);
  if (!fs.existsSync(b)) fail(`IDENTICAL欠落: ${f}`);
  else if (templateOptOut.includes(f)) continue; // 意図的な廃止を宣言済み
  else if (!fs.existsSync(a))
    fail(`IDENTICAL未受領: ${f}(このFactoryに無い — テンプレートからコピーが必要)`);
  else if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8"))
    fail(`IDENTICAL乖離: ${f}(SRCから再コピーが必要)`);
}

// レンダーエンジン(既定 remotion)。HF_IDENTICAL の要否を決める
const renderEngine = channelSystem.renderEngine || "remotion";

// HF部品の意図的な不採用。そのチャンネルが「この仕組みを運用しない」と決めた場合に
// .channel-system.json の hfOptOut: string[] へパスを列挙すると、そのファイルは
// 未受領でも乖離でもNGにしない(CORE_IDENTICAL の coreOverrides と同じ思想)。
// 例: 視覚多様性検査(check-composition.ts 一式)を廃止したチャンネル。
// 「テンプレ側に存在すること」の検査だけは opt-out できない(scaffold元のため)。
const hfOptOut = channelSystem.hfOptOut ?? [];

for (const f of HF_IDENTICAL) {
  const a = path.join(SRC, f);
  const b = path.join(TPL, f);
  if (!fs.existsSync(b)) {
    fail(`HF_IDENTICAL欠落(テンプレ側): ${f}`);
    continue;
  }
  if (renderEngine !== "hyperframes") continue; // Remotionチャンネルでは検査しない
  if (hfOptOut.includes(f)) continue; // 意図的な不採用を宣言済み
  if (!fs.existsSync(a))
    fail(
      `HF_IDENTICAL未受領: ${f}(このFactoryに無い — テンプレートからコピーが必要。` +
        `意図的に運用しないなら .channel-system.json の hfOptOut に追加)`
    );
  else if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8"))
    fail(`HF_IDENTICAL乖離: ${f}(SRCから再コピーが必要)`);
}

const h3Enabled = !!channelSystem.h3Pipeline;
for (const f of H3_IDENTICAL) {
  const a = path.join(SRC, f);
  const b = path.join(TPL, f);
  if (!fs.existsSync(b)) {
    fail(`H3_IDENTICAL欠落(テンプレ側): ${f}`);
    continue;
  }
  if (!h3Enabled) continue; // H3 未採用のチャンネルでは存在しなくてよい
  if (templateOptOut.includes(f)) continue;
  if (!fs.existsSync(a)) {
    fail(`H3_IDENTICAL未受領: ${f}(h3Pipeline を宣言したチャンネルに無い)`);
    continue;
  }
  if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8")) {
    fail(`H3_IDENTICAL乖離: ${f}(SRCから再コピーが必要)`);
  }
}

const coreOverrides = channelSystem.coreOverrides ?? [];

for (const f of CORE_IDENTICAL) {
  const a = path.join(SRC, f);
  const b = path.join(TPL, f);
  if (!fs.existsSync(b)) {
    fail(`CORE欠落(テンプレ側): ${f}`);
    continue;
  }
  if (templateOptOut.includes(f)) continue; // 意図的な廃止を宣言済み
  if (!fs.existsSync(a)) {
    fail(`CORE未受領: ${f}(このFactoryに無い — テンプレートからコピーが必要)`);
    continue;
  }
  if (coreOverrides.includes(f)) continue; // 再スキン宣言済み(props契約互換が条件)
  if (fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8"))
    fail(
      `CORE乖離: ${f}(SRC側の改善なら/system-refineで還元、受領漏れならテンプレからコピー。` +
        `意図的な再スキンなら .channel-system.json の coreOverrides に追加)`
    );
}

for (const f of VARIANT) {
  if (!fs.existsSync(path.join(TPL, f))) fail(`VARIANT欠落: ${f}`);
  else if (templateOptOut.includes(f)) continue; // 意図的な廃止を宣言済み
  else if (
    !VARIANT_TEMPLATE_ONLY.includes(f) &&
    !fs.existsSync(path.join(SRC, f))
  )
    fail(`VARIANT未受領: ${f}(このFactoryに無い — テンプレ版を基に同等適用が必要)`);
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
  let ahead;
  try {
    ahead = execSync("git rev-list --count @{u}..HEAD", opts).toString().trim();
  } catch {
    fail("channel-builderに上流追跡ブランチが無い(git push -u origin main が必要?)");
    return;
  }
  if (ahead !== "0") {
    fail(`channel-builderにpush漏れのコミットが${ahead}件ある(git push が必要)`);
  }
}
checkBuilderRepoPushed();

if (failures === 0) {
  console.log(
    `OK: テンプレート同期は健全(IDENTICAL ${IDENTICAL.length} / HF ${HF_IDENTICAL.length}(engine=${renderEngine}) / H3 ${H3_IDENTICAL.length}(${h3Enabled ? "on" : "off"}) / CORE ${CORE_IDENTICAL.length} / VARIANT ${VARIANT.length} / 禁止語 ${FORBIDDEN.length}種スキャン)`
  );
} else {
  console.error(`\n${failures}件の乖離。同期後に再実行すること。`);
}
process.exit(failures === 0 ? 0 : 1);
