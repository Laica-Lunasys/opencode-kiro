import assert from "node:assert/strict"
import { test } from "node:test"
import { definitions } from "../dist/index.js"
import { parseModels } from "../dist/models.js"

test("maps the CLI model inventory into OpenCode definitions", () => {
  const models = parseModels({ models: [
    { model_id: "auto", model_name: "Automatic", context_window_tokens: 1_000_000, rate_multiplier: 1 },
    { model_id: "claude-opus-5", model_name: "Claude Opus 5", context_window_tokens: 200_000, rate_multiplier: 2.2 },
  ] })
  const [auto, opus] = definitions(models)
  assert.equal(auto.providerID, "kiro")
  assert.equal(auto.modelID, "auto")
  assert.equal(auto.limit.context, 1_000_000)
  assert.equal(opus.name, "Claude Opus 5 (2.2x credits)")
  assert.equal(opus.limit.output, 64_000)
  assert.deepEqual(opus.capabilities.input, ["text", "image"])
})

test("rejects invalid or duplicate model inventories", () => {
  const model = { model_id: "auto", context_window_tokens: 1000 }
  assert.throws(() => parseModels({ models: [model, model] }), /duplicate/)
  assert.throws(() => parseModels({ models: [{ ...model, context_window_tokens: 0 }] }), /Invalid/)
  assert.throws(() => parseModels({ models: [{ ...model, rate_multiplier: -1 }] }), /Invalid/)
  assert.throws(() => parseModels({ models: {} }), /Unexpected/)
})
