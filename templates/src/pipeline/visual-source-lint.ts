import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export type TextSizeViolation = {
  file: string;
  line: number;
  sizePx: number;
  minPx: number;
};

const ALLOW_COMMENT = "visual-text-lint-allow";

/** TSX中の `fontSize: 24` / `fontSize={24}` の数値リテラルを検査する。 */
export function lintTextSizeSource(
  source: string,
  file: string,
  minPx: number
): TextSizeViolation[] {
  const violations: TextSizeViolation[] = [];
  source.split("\n").forEach((line, index) => {
    if (line.includes(ALLOW_COMMENT)) return;
    const matches = line.matchAll(/fontSize\s*[:=]\s*\{?\s*(\d+(?:\.\d+)?)/g);
    for (const match of matches) {
      const sizePx = Number(match[1]);
      if (sizePx < minPx) violations.push({ file, line: index + 1, sizePx, minPx });
    }
  });
  return violations;
}

export function lintTextSizesInDirectory(
  directory: string,
  minPx: number
): TextSizeViolation[] {
  if (!existsSync(directory)) return [];
  const violations: TextSizeViolation[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".tsx")) continue;
    const filePath = path.join(directory, name);
    violations.push(
      ...lintTextSizeSource(readFileSync(filePath, "utf8"), name, minPx)
    );
  }
  return violations;
}
