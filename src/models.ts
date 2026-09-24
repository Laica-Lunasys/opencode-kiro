import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

export interface KiroModel {
  id: string
  name: string
  context: number
  multiplier: number
}

export function parseModels(value: unknown): KiroModel[] {
  if (typeof value !== "object" || value === null || !("models" in value) || !Array.isArray(value.models)) {
    throw new Error("Unexpected response from kiro-cli chat --list-models")
  }

  const ids = new Set<string>()
  return value.models.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("Invalid Kiro model")
    const model = item as Record<string, unknown>
    const id = model.model_id
    const context = model.context_window_tokens
    if (typeof id !== "string" || !id || ids.has(id) || typeof context !== "number" || !Number.isSafeInteger(context) || context <= 0 ||
      (model.rate_multiplier !== undefined && (typeof model.rate_multiplier !== "number" || !Number.isFinite(model.rate_multiplier) || model.rate_multiplier < 0))) {
      throw new Error("Invalid or duplicate Kiro model")
    }
    ids.add(id)
    return {
      id,
      name: typeof model.model_name === "string" ? model.model_name : id,
      context,
      multiplier: typeof model.rate_multiplier === "number" ? model.rate_multiplier : 1,
    }
  })
}

export async function listModels(): Promise<KiroModel[]> {
  const { stdout } = await run("kiro-cli", ["chat", "--list-models", "--format", "json"], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  })
  return parseModels(JSON.parse(stdout))
}
