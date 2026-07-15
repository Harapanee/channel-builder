#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { isResolvableComponent } from "../scenes/registry";
import type { LibraryFile, ShotsFile, TimingFile } from "../schemas/types";

/**
 * §5.6 shots.json の検証(レンダリング前に必ずエラーとして検出する)。
 *
 * 検証規則(仕様書 §5.6 準拠、5項目すべて):
 * 1. ショットは時間順で、隙間0.2秒超・重複を禁止。全体で
 *    [0, narration.durationSec] を被覆する
 * 2. scene.component はレジストリ(§7.6, src/scenes/registry.ts)で
 *    解決可能であること
 * 3. assets の全IDが library.json に存在し、ファイルが実在すること
 * 4. sfx[].cue が assets/audio/se/ に存在すること
 * 5. 全 lineIds が timing.json に存在し、重複割り当てがないこと
 *
 * これに加えて ajv による shots.json / timing.json / library.json の
 * JSON Schema検証を行う。スキーマ違反がある場合はビジネスルール検証より
 * 先に報告し、誤情報を避けるためビジネスルール検証は中断する。
 */

const GAP_TOLERANCE_SEC = 0.2;
const EPSILON = 1e-6;

const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../schemas"
);

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, name), "utf-8"));
}

function loadJson<T>(absPath: string): T {
  return JSON.parse(readFileSync(absPath, "utf-8")) as T;
}

export class ValidationReport {
  errors: string[] = [];
  /** 合否に影響しない注意喚起(exit code を変えない)。 */
  warnings: string[] = [];
  add(message: string): void {
    this.errors.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  get ok(): boolean {
    return this.errors.length === 0;
  }
}

function formatAjvErrors(
  errors: ErrorObject[] | null | undefined,
  fileLabel: string
): string[] {
  if (!errors) return [];
  return errors.map(
    (e) => `[schema:${fileLabel}] ${e.instancePath || "(root)"} ${e.message}`
  );
}

function validateTimeline(shots: ShotsFile, report: ValidationReport): void {
  const list = shots.shots;
  if (list.length === 0) {
    report.add("shots が空です。[0, narration.durationSec] を被覆できません");
    return;
  }

  for (const shot of list) {
    if (shot.endSec <= shot.startSec) {
      report.add(
        `[${shot.shotId}] endSec (${shot.endSec}) は startSec (${shot.startSec}) より大きくなければなりません`
      );
    }
  }

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const curr = list[i];

    if (curr.startSec + EPSILON < prev.startSec) {
      report.add(
        `ショットが時間順に並んでいません: ${prev.shotId}(start=${prev.startSec}) の後に ${curr.shotId}(start=${curr.startSec}) が続いています`
      );
      continue;
    }

    const gap = curr.startSec - prev.endSec;
    if (gap < -EPSILON) {
      report.add(
        `${prev.shotId} と ${curr.shotId} が ${Math.abs(gap).toFixed(3)}秒 重複しています(重複は禁止)`
      );
    } else if (gap > GAP_TOLERANCE_SEC + EPSILON) {
      report.add(
        `${prev.shotId} と ${curr.shotId} の間に ${gap.toFixed(3)}秒 の隙間があります(0.2秒超は禁止)`
      );
    }
  }

  const first = list[0];
  const last = list[list.length - 1];
  if (Math.abs(first.startSec - 0) > EPSILON) {
    report.add(
      `最初のショット ${first.shotId} の startSec は 0 である必要があります(実際: ${first.startSec})`
    );
  }
  if (Math.abs(last.endSec - shots.narration.durationSec) > EPSILON) {
    report.add(
      `最後のショット ${last.shotId} の endSec (${last.endSec}) は narration.durationSec (${shots.narration.durationSec}) と一致する必要があります(全体を被覆していません)`
    );
  }
}

/**
 * 視覚多様性の定量規則(チャンネル別オプトイン)。
 *
 * `channel/visual-rules.json` が存在するチャンネルでのみ有効になる。
 * ファイルが無ければ全ルールをスキップする(AI生成主体・非スライドショー等、
 * 形式の異なるチャンネルに一律適用しないため)。しきい値は同ファイルで指定する:
 *
 *   { "minDurationSec": 300,        // これ未満の尺には適用しない(スモーク用短尺の除外)
 *     "maxUsesPerImage": 3,         // 同一画像の使用回数上限(超過は BLOCK)
 *     "minUniqueImagesPerMin": 4,   // ユニーク画像密度の下限(枚/分)
 *     "maxAiRatio": 0.5 }           // source:"ai_image" のユニーク比率上限
 *
 * 各キーは省略可(省略したルールは検査しない)。shorts/ は常に対象外。
 */
interface VisualRulesConfig {
  minDurationSec?: number;
  maxUsesPerImage?: number;
  minUniqueImagesPerMin?: number;
  maxAiRatio?: number;
}

function loadVisualRules(projectRoot: string): VisualRulesConfig | null {
  const p = path.join(projectRoot, "channel", "visual-rules.json");
  if (!existsSync(p)) return null;
  return loadJson<VisualRulesConfig>(p);
}

function validateVisualDiversity(
  shots: ShotsFile,
  library: LibraryFile,
  rules: VisualRulesConfig,
  report: ValidationReport
): void {
  const durationSec = shots.narration.durationSec;
  if (durationSec < (rules.minDurationSec ?? 300)) return;

  const libraryIndex = new Map(library.assets.map((a) => [a.assetId, a]));
  const useCount = new Map<string, number>();
  for (const shot of shots.shots) {
    for (const assetId of shot.assets) {
      if (!libraryIndex.has(assetId)) continue; // 存在チェックは Rule 3 が担当
      useCount.set(assetId, (useCount.get(assetId) ?? 0) + 1);
    }
  }

  // Rule 6: 同一画像の使用回数上限
  if (rules.maxUsesPerImage !== undefined) {
    for (const [assetId, count] of useCount) {
      if (count > rules.maxUsesPerImage) {
        report.add(
          `[visual] assetId "${assetId}" が ${count} 回使用されています(同一画像はエピソード全体で${rules.maxUsesPerImage}回まで。channel/visual-rules.json)`
        );
      }
    }
  }

  // Rule 7: ユニーク画像密度
  const uniqueCount = useCount.size;
  if (rules.minUniqueImagesPerMin !== undefined) {
    const perMin = uniqueCount / (durationSec / 60);
    if (perMin < rules.minUniqueImagesPerMin) {
      report.add(
        `[visual] ユニーク画像密度が ${perMin.toFixed(1)}枚/分 です(尺${(durationSec / 60).toFixed(1)}分に対しユニーク${uniqueCount}枚。1分あたり${rules.minUniqueImagesPerMin}枚以上が必要。channel/visual-rules.json)`
      );
    }
  }

  // Rule 8: AI生成比率の上限
  if (rules.maxAiRatio !== undefined && uniqueCount > 0) {
    let aiCount = 0;
    for (const assetId of useCount.keys()) {
      if (libraryIndex.get(assetId)?.source === "ai_image") aiCount++;
    }
    const aiRatio = aiCount / uniqueCount;
    if (aiRatio > rules.maxAiRatio) {
      report.add(
        `[visual] AI生成画像がユニーク${uniqueCount}枚中 ${aiCount}枚(${(aiRatio * 100).toFixed(0)}%)です(上限${rules.maxAiRatio * 100}%。PD/CC調達・ライブラリ再利用を主体にする。channel/visual-rules.json)`
      );
    }
  }
}

export function validateEpisode(
  episodeDir: string,
  projectRoot: string
): ValidationReport {
  const report = new ValidationReport();

  const episodeAbsDir = path.join(projectRoot, episodeDir);
  const shotsPath = path.join(episodeAbsDir, "shots.json");
  const timingPath = path.join(episodeAbsDir, "timing.json");
  const libraryPath = path.join(projectRoot, "assets", "library.json");

  for (const [label, p] of [
    ["shots.json", shotsPath],
    ["timing.json", timingPath],
    ["assets/library.json", libraryPath],
  ] as const) {
    if (!existsSync(p)) {
      report.add(`${label} が見つかりません: ${p}`);
    }
  }
  if (!report.ok) return report;

  const shots = loadJson<ShotsFile>(shotsPath);
  const timing = loadJson<TimingFile>(timingPath);
  const library = loadJson<LibraryFile>(libraryPath);

  // ---- ajv によるスキーマ検証 -------------------------------------------
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);

  const validateShotsSchema = ajv.compile(loadSchema("shots.schema.json"));
  const validateTimingSchema = ajv.compile(loadSchema("timing.schema.json"));
  const validateLibrarySchema = ajv.compile(loadSchema("library.schema.json"));

  if (!validateShotsSchema(shots)) {
    report.errors.push(
      ...formatAjvErrors(validateShotsSchema.errors, "shots.json")
    );
  }
  if (!validateTimingSchema(timing)) {
    report.errors.push(
      ...formatAjvErrors(validateTimingSchema.errors, "timing.json")
    );
  }
  if (!validateLibrarySchema(library)) {
    report.errors.push(
      ...formatAjvErrors(validateLibrarySchema.errors, "library.json")
    );
  }

  // スキーマ自体が壊れている場合、以降のビジネスルール検証は
  // 誤情報を生みやすいためここで打ち切る。
  if (!report.ok) return report;

  // ---- Rule 1: 時間順・隙間0.2秒超禁止・重複禁止・全体被覆 --------------
  validateTimeline(shots, report);

  // ---- Rule 2: scene.component はレジストリで解決可能 --------------------
  for (const shot of shots.shots) {
    if (!isResolvableComponent(shot.scene.component)) {
      report.add(
        `[${shot.shotId}] scene.component "${shot.scene.component}" はレジストリ(src/scenes/registry.ts)で解決できません`
      );
    }
  }

  // ---- Rule 3: assets は library.json に存在し、ファイルが実在する ------
  const libraryIndex = new Map(library.assets.map((a) => [a.assetId, a]));
  for (const shot of shots.shots) {
    for (const assetId of shot.assets) {
      const asset = libraryIndex.get(assetId);
      if (!asset) {
        report.add(
          `[${shot.shotId}] assetId "${assetId}" が assets/library.json に存在しません`
        );
        continue;
      }
      const assetAbsPath = path.join(projectRoot, "assets", asset.file);
      if (!existsSync(assetAbsPath)) {
        report.add(
          `[${shot.shotId}] assetId "${assetId}" のファイルが実在しません: ${assetAbsPath}`
        );
      }
    }
  }

  // ---- Rule 4: sfx[].cue が assets/audio/se/ に存在する ------------------
  const seDir = path.join(projectRoot, "assets", "audio", "se");
  for (const shot of shots.shots) {
    for (const sfx of shot.sfx ?? []) {
      const cuePath = path.join(seDir, sfx.cue);
      if (!existsSync(cuePath)) {
        report.add(
          `[${shot.shotId}] sfx cue "${sfx.cue}" が assets/audio/se/ に存在しません: ${cuePath}`
        );
      }
    }
  }

  // ---- Rule 3b: shotId の一意性(章並列統合時の重複を検出) ----------------
  const shotIdSeen = new Set<string>();
  for (const shot of shots.shots) {
    if (shotIdSeen.has(shot.shotId)) {
      report.add(`shotId "${shot.shotId}" が重複しています`);
    }
    shotIdSeen.add(shot.shotId);
  }

  // ---- Rule 4b: bgm / bgmTracks のファイル実在と区間の妥当性 --------------
  const assetsDir = path.join(projectRoot, "assets");
  if (shots.bgm && !existsSync(path.join(assetsDir, shots.bgm.file))) {
    report.add(`bgm file "${shots.bgm.file}" が assets/ に存在しません`);
  }
  for (const [i, t] of (shots.bgmTracks ?? []).entries()) {
    if (!existsSync(path.join(assetsDir, t.file))) {
      report.add(`bgmTracks[${i}] file "${t.file}" が assets/ に存在しません`);
    }
    if (t.endSec <= t.startSec) {
      report.add(
        `bgmTracks[${i}] の区間が不正です(startSec ${t.startSec} >= endSec ${t.endSec})`
      );
    }
    if (t.endSec > shots.narration.durationSec + 0.5) {
      report.add(
        `bgmTracks[${i}] の endSec (${t.endSec}) が動画尺(${shots.narration.durationSec})を超えています`
      );
    }
  }

  // ---- Warning: DoodleCharacter に assetId が無い(プレースホルダ描画) ---
  // DoodleCharacter は assetId 未指定だと点線プレースホルダを描く仕様のため、
  // 本番レンダーに点線が出る可能性を警告する(エラーにはしない)。
  for (const shot of shots.shots) {
    if (shot.scene.component !== "DoodleCharacter") continue;
    const assetId = (shot.scene.props as Record<string, unknown>)?.assetId;
    if (typeof assetId !== "string" || assetId.length === 0) {
      report.warn(
        `[${shot.shotId}] DoodleCharacter に props.assetId がありません(点線プレースホルダが本番に出る可能性)`
      );
    }
  }

  // ---- Rule 6-8: 視覚多様性の定量規則(オプトイン。shorts/ は対象外) -----
  const visualRules = loadVisualRules(projectRoot);
  if (visualRules && !episodeDir.replace(/\\/g, "/").includes("shorts/")) {
    validateVisualDiversity(shots, library, visualRules, report);
  }

  // ---- Rule 5: lineIds が timing.json に存在し、重複割り当てがない -------
  const timingLineIds = new Set(timing.lines.map((l) => l.lineId));
  const assignedLineIds = new Map<string, string>(); // lineId -> owner shotId
  for (const shot of shots.shots) {
    for (const lineId of shot.lineIds) {
      if (!timingLineIds.has(lineId)) {
        report.add(
          `[${shot.shotId}] lineId "${lineId}" が timing.json に存在しません`
        );
        continue;
      }
      const owner = assignedLineIds.get(lineId);
      if (owner && owner !== shot.shotId) {
        report.add(
          `lineId "${lineId}" が複数のショット(${owner}, ${shot.shotId})に重複割り当てされています`
        );
      } else {
        assignedLineIds.set(lineId, shot.shotId);
      }
    }
  }

  return report;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      path.resolve(fileURLToPath(import.meta.url)) ===
      path.resolve(process.argv[1])
    );
  } catch {
    return false;
  }
}

function main() {
  const episodeDir = process.argv[2];
  if (!episodeDir) {
    console.error("Usage: validate-shots.ts <episodeDir>");
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const report = validateEpisode(episodeDir, projectRoot);

  // 警告は合否に関わらず表示する(exit code には影響しない)
  if (report.warnings.length > 0) {
    console.warn(`warning: ${report.warnings.length} 件の注意があります`);
    for (const w of report.warnings) {
      console.warn(` ~ ${w}`);
    }
  }

  if (report.ok) {
    console.log(`OK: ${episodeDir} は全ての検証に合格しました`);
    process.exit(0);
  } else {
    console.error(
      `NG: ${episodeDir} に ${report.errors.length} 件の検証エラーがあります`
    );
    for (const e of report.errors) {
      console.error(` - ${e}`);
    }
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
