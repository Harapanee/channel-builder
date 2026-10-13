/** Prepare an asset-generator job; accept only its explicitly identified output. */
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { atomicJson, fileHash, hash, json, lock } from "./provenance";
export function chooseSource(
  ep: string,
  en: { thumbSource?: string },
  hasLive: boolean,
) {
  return en.thumbSource
    ? path.resolve(ep, en.thumbSource)
    : hasLive
      ? path.join(ep, "publish/en/thumb-ja-live.jpg")
      : path.join(ep, "publish/thumb-1.png");
}
export function validateImageSize(w: number, h: number) {
  if (w !== 1280 || h !== 720)
    throw Error(`Expected 1280x720 PNG, received ${w}x${h}`);
}
function dimensions(p: string) {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name",
        "-of",
        "json",
        p,
      ],
      { encoding: "utf8" },
    ),
  ).streams?.[0];
}
export function prepare(ep: string) {
  const en = json(path.join(ep, "en/en.json"));
  if (!en.thumbText?.trim()) throw Error("missing thumbText");
  const source = chooseSource(
    ep,
    en,
    existsSync(path.join(ep, "publish/en/thumb-ja-live.jpg")),
  );
  const sourceHash = fileHash(source),
    textHash = hash(en.thumbText),
    id = randomUUID();
  const dir = path.join(ep, "publish/en/thumb-jobs", id);
  mkdirSync(dir, { recursive: true });
  const ref = path.join(dir, "source" + path.extname(source));
  copyFileSync(source, ref);
  const template = readFileSync("channel/english/thumb-prompt.txt", "utf8"),
    prompt = template.split("{{THUMB_TEXT}}").join(en.thumbText);
  const job = {
    schema: 1,
    id,
    source,
    reference: path.resolve(ref),
    sourceHash,
    textHash,
    thumbText: en.thumbText,
    prompt,
    promptHash: hash(prompt),
    createdAt: new Date().toISOString(),
  };
  atomicJson(path.join(dir, "job.json"), job);
  return job;
}
export function accept(ep: string, id: string, file: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("invalid job id");
  const release = lock(path.join(ep, "publish/en"));
  try {
    const job = json(path.join(ep, "publish/en/thumb-jobs", id, "job.json")),
      en = json(path.join(ep, "en/en.json"));
    if (job.id !== id || job.schema !== 1) throw Error("invalid job");
    const source = chooseSource(
      ep,
      en,
      existsSync(path.join(ep, "publish/en/thumb-ja-live.jpg")),
    );
    if (
      source !== job.source ||
      fileHash(source) !== job.sourceHash ||
      hash(en.thumbText) !== job.textHash ||
      fileHash(job.reference) !== job.sourceHash
    )
      throw Error("source/text changed since prepare");
    const d = dimensions(file);
    validateImageSize(d?.width, d?.height);
    if (d.codec_name !== "png") throw Error("PNG output required");
    const out = path.join(ep, "publish/en/thumb-en.png"),
      tmp = out + `.${process.pid}.tmp`;
    copyFileSync(file, tmp);
    const outputHash = fileHash(tmp);
    renameSync(tmp, out);
    atomicJson(path.join(ep, "publish/en/thumb-en-manifest.json"), {
      ...job,
      acceptedAt: new Date().toISOString(),
      agentOutput: path.resolve(file),
      outputHash,
    });
    return out;
  } finally {
    release();
  }
}
if (process.argv[1]?.endsWith("en-thumb.ts")) {
  const [mode, epId] = process.argv.slice(2),
    ep = path.resolve("episodes", epId ?? "");
  if (!epId || !["prepare", "accept"].includes(mode))
    throw Error(
      "usage: en-thumb.ts prepare <epId> | accept <epId> --job <id> --file <exact PNG>",
    );
  if (mode === "prepare") console.log(JSON.stringify(prepare(ep), null, 2));
  else {
    const arg = (key: string) => {
      const i = process.argv.indexOf(key);
      if (i < 0 || !process.argv[i + 1]) throw Error(`missing ${key}`);
      return process.argv[i + 1];
    };
    console.log(accept(ep, arg("--job"), arg("--file")));
  }
}
