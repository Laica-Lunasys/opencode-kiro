import { Model, Plugin, Provider } from "@opencode/plugin"
import { createKiroAcp, type KiroACPProvider } from "kiro-acp-ai-provider"
import { listModels, type KiroModel } from "./models.js"

const providerID = Provider.ID.make("kiro")
const providerPackage = "aisdk:kiro-acp-ai-provider"

export function definitions(models: readonly KiroModel[]): Model.Info[] {
  return models.map((model) => ({
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    name: `${model.name} (${model.multiplier}x credits)`,
    limit: { context: model.context, output: Math.min(64_000, model.context) },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  }))
}

export default Plugin.define({
  id: "laica.kiro-acp",
  async setup(ctx) {
    // Kiro CLI owns authentication; no tokens are stored in OpenCode.
    let models = await listModels()
    if (!models.length) throw new Error("Kiro CLI returned no models")
    let closed = false
    const provider = createKiroAcp({
      cwd: ctx.location.directory,
      onPermission(request) {
        const once = request.options.find((option) => option.id === "allow_once")
        return once ? { outcome: { outcome: "selected", optionId: once.id } } : { outcome: { outcome: "cancelled" } }
      },
      clientInfo: { name: "opencode-kiro", version: ctx.app.version },
    })

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Amazon Kiro (ACP)",
          package: providerPackage,
          activation: "enabled",
        },
        models: definitions(models),
      })
    })

    await ctx.aisdk.hook("sdk", (event) => {
      event.sdk = provider
    }, { providerID })

    await ctx.aisdk.hook("language", (event) => {
      const effort = typeof event.options.effort === "string" ? event.options.effort : undefined
      event.language = (event.sdk as KiroACPProvider).languageModel(String(event.model.modelID), {
        contextWindow: event.model.limit.context,
        ...(effort ? { effort } : {}),
      })
    }, { providerID })

    const refresh = setInterval(() => {
      void listModels().then(async (updated) => {
        if (closed || !updated.length || JSON.stringify(updated) === JSON.stringify(models)) return
        models = updated
        await ctx.provider.reload()
      }).catch((error) => console.error("[opencode-kiro] model refresh failed:", error))
    }, 10 * 60_000)

    return async () => {
      closed = true
      clearInterval(refresh)
      await provider.shutdown()
    }
  },
})
