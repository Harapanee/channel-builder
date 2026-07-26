import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv, { type AnySchema, type ValidateFunction } from "ajv";

type ContractMap = Record<string, AnySchema>;

const comparisonSideSchema: AnySchema = {
  type: "object",
  required: ["label", "value"],
  properties: {
    label: { type: "string" },
    value: { type: "number" },
    assetId: { type: "string", minLength: 1 },
  },
  additionalProperties: true,
};

/** 全チャンネル共通コンポーネントの実行時props契約。 */
export const BASE_COMPONENT_CONTRACTS: ContractMap = {
  ComparisonSplit: {
    type: "object",
    required: ["left", "right", "mode"],
    properties: {
      left: comparisonSideSchema,
      right: comparisonSideSchema,
      mode: { enum: ["bars", "count", "size"] },
      countUpDurationFrames: { type: "number", exclusiveMinimum: 0 },
    },
    additionalProperties: true,
  },
};

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadProjectContracts(projectRoot: string): {
  contracts: ContractMap;
  errors: string[];
} {
  const contracts: ContractMap = { ...BASE_COMPONENT_CONTRACTS };
  const errors: string[] = [];
  const contractPath = path.join(projectRoot, "channel", "component-contracts.json");
  if (existsSync(contractPath)) {
    try {
      const custom = readJson(contractPath);
      if (!isRecord(custom)) {
        errors.push("channel/component-contracts.json はコンポーネント名をキーにしたオブジェクトである必要があります");
      } else {
        for (const [component, schema] of Object.entries(custom)) {
          if (!isRecord(schema)) {
            errors.push(`component-contracts.json の ${component} はJSON Schemaオブジェクトである必要があります`);
            continue;
          }
          contracts[component] = contracts[component]
            ? { allOf: [contracts[component], schema] }
            : schema;
        }
      }
    } catch (error) {
      errors.push(`channel/component-contracts.json を読めません: ${String(error)}`);
    }
  }

  // 旧 required-props.json は後方互換として契約の required へ変換する。
  const legacyPath = path.join(projectRoot, "channel", "required-props.json");
  if (existsSync(legacyPath)) {
    try {
      const legacy = readJson(legacyPath);
      if (!isRecord(legacy)) throw new Error("ルートがオブジェクトではありません");
      for (const [component, keys] of Object.entries(legacy)) {
        if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
          errors.push(`required-props.json の ${component} は文字列配列である必要があります`);
          continue;
        }
        const requiredOnly: AnySchema = { type: "object", required: keys };
        contracts[component] = contracts[component]
          ? { allOf: [contracts[component], requiredOnly] }
          : requiredOnly;
      }
    } catch (error) {
      errors.push(`channel/required-props.json を読めません: ${String(error)}`);
    }
  }
  return { contracts, errors };
}

export class ComponentPropsValidator {
  readonly configurationErrors: string[];
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(projectRoot: string) {
    const { contracts, errors } = loadProjectContracts(projectRoot);
    this.configurationErrors = [...errors];
    // required-only の小さな追加契約も許可する。その他の未知キーワード等は
    // strict mode で引き続き設定エラーとして扱う。
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
    for (const [component, schema] of Object.entries(contracts)) {
      try {
        this.validators.set(component, ajv.compile(schema));
      } catch (error) {
        this.configurationErrors.push(
          `component-contracts.json の ${component} をコンパイルできません: ${String(error)}`
        );
      }
    }
  }

  validate(component: string, props: unknown): string[] {
    const baseName = component.replace(/^custom:/, "");
    const validator = this.validators.get(baseName);
    if (!validator || validator(props)) return [];
    return (validator.errors ?? []).map((error) => {
      const location = error.instancePath ? `props${error.instancePath}` : "props";
      return `${location} ${error.message ?? "が契約に適合しません"}`;
    });
  }
}
