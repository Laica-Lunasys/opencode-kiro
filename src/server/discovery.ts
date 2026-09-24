import { Model, Provider, type Integration, type Plugin } from "@opencode/plugin"
import type { KiroACPProviderSettings, ModelWithEfforts } from "kiro-acp-ai-provider"
import { KIRO_INTEGRATION_ID, KIRO_INTEGRATION_NAME } from "./auth.js"

export const KIRO_PROVIDER_ID = "kiro"
export const KIRO_PROVIDER_PACKAGE = "aisdk:kiro-acp-ai-provider"

const DISCOVERY_TIMEOUT_MS = 60_000
const RETRY_BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000]
const LOG_PREFIX = "[opencode-kiro]"
const FALLBACK_CONTEXT_WINDOW = 1_000_000
const FALLBACK_OUTPUT_LIMIT = 64_000

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0]
type MutableModel = Parameters<Parameters<ProviderEditor["models"]["update"]>[2]>[0]
type ServerEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event>
    ? Event
    : never

export interface KiroPluginOptions {
  agent: string
  mcpTimeout: number
  discover: boolean
  stall?: NonNullable<KiroACPProviderSettings["stall"]>
}

export interface DiscoveryState {
  cwd: string
  options: KiroPluginOptions
  snapshot: readonly ModelWithEfforts[] | undefined
  generation: number
  inflight: Promise<void> | undefined
  probeTimer: ReturnType<typeof setTimeout> | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

export interface DiscoveryResources {
  state: DiscoveryState | undefined
  disposeTransform: (() => Promise<void>) | undefined
  eventController: AbortController | undefined
  eventTask: Promise<void> | undefined
}

export function createDiscoveryResources(): DiscoveryResources {
  return {
    state: undefined,
    disposeTransform: undefined,
    eventController: undefined,
    eventTask: undefined,
  }
}

function asString(value: unknown): string {
  return value as string
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cancelRetry(state: DiscoveryState): void {
  if (state.retryTimer === undefined) return
  clearTimeout(state.retryTimer)
  state.retryTimer = undefined
}

function clearDiscoveryTimers(state: DiscoveryState): void {
  if (state.probeTimer !== undefined) {
    clearTimeout(state.probeTimer)
    state.probeTimer = undefined
  }
  cancelRetry(state)
}

function effortSettings(effort: string): { effort: string } {
  return { effort } satisfies Pick<KiroACPProviderSettings, "effort">
}

function applyEfforts(model: MutableModel, runtimeModel: ModelWithEfforts): void {
  if (runtimeModel.runtimeEfforts.length === 0) return

  if (runtimeModel.baselineEffort !== undefined) {
    model.settings = { ...model.settings, ...effortSettings(runtimeModel.baselineEffort) }
  }

  for (const effort of runtimeModel.runtimeEfforts) {
    const existing = model.variants.find((variant) => asString(variant.id) === effort)
    if (existing) {
      existing.settings = { ...existing.settings, ...effortSettings(effort) }
      continue
    }
    model.variants.push({
      id: effort as Model.VariantID,
      settings: effortSettings(effort),
    })
  }
}

function runtimeModelInfo(
  runtimeModel: ModelWithEfforts,
  catalogModel: Model.Info | undefined,
): Model.Info {
  const providerID = KIRO_PROVIDER_ID as Provider.ID
  const modelID = runtimeModel.modelId as Model.ID
  const model = structuredClone(
    catalogModel ?? Model.Info.default(providerID, modelID),
  ) as MutableModel

  model.id = modelID
  model.modelID = modelID
  model.providerID = providerID
  model.name = runtimeModel.name || runtimeModel.modelId
  model.enabled = true
  model.limit.context = model.limit.context > 0 ? model.limit.context : FALLBACK_CONTEXT_WINDOW
  model.limit.output = model.limit.output > 0 ? model.limit.output : FALLBACK_OUTPUT_LIMIT
  applyEfforts(model, runtimeModel)
  return model as unknown as Model.Info
}

/**
 * Apply the last successful ACP model snapshot. Kiro's runtime list is
 * authoritative: catalog metadata is reused when available, while newly
 * released runtime models are added with safe defaults instead of being lost
 * to a catalog intersection.
 */
export function applyCatalogSnapshot(editor: ProviderEditor, state: DiscoveryState): void {
  const snapshot = state.snapshot
  if (!snapshot?.length) return

  const existing = editor.get(KIRO_PROVIDER_ID)
  const catalogByModelID = new Map<string, Model.Info>()
  for (const model of existing?.models.values() ?? []) {
    catalogByModelID.set(asString(model.modelID), model)
  }

  const models = snapshot.map((runtimeModel) =>
    runtimeModelInfo(runtimeModel, catalogByModelID.get(runtimeModel.modelId)),
  )
  const contextWindows = Object.fromEntries(
    models.map((model) => [asString(model.modelID), model.limit.context]),
  )
  const settings = {
    ...existing?.provider.settings,
    cwd: state.cwd,
    agent: state.options.agent,
    trustAllTools: true,
    mcpTimeout: state.options.mcpTimeout,
    ...(state.options.stall ? { stall: state.options.stall } : {}),
    contextWindows,
  }

  if (existing) {
    editor.update(KIRO_PROVIDER_ID, (provider) => {
      provider.name = KIRO_INTEGRATION_NAME
      provider.integrationID = KIRO_INTEGRATION_ID as Integration.ID
      provider.activation = "enabled"
      provider.package = KIRO_PROVIDER_PACKAGE
      provider.settings = settings
    })
    editor.models.set(KIRO_PROVIDER_ID, models)
    return
  }

  const info: Provider.Info = {
    ...Provider.Info.empty(KIRO_PROVIDER_ID as Provider.ID),
    name: KIRO_INTEGRATION_NAME,
    integrationID: KIRO_INTEGRATION_ID as Integration.ID,
    activation: "enabled",
    package: KIRO_PROVIDER_PACKAGE,
    settings,
  }
  editor.add({ info, models })
}

export function createDiscover(
  context: Plugin.Context,
  state: DiscoveryState,
): (reason: string) => Promise<void> {
  async function publish(
    generation: number,
    discovered: readonly ModelWithEfforts[],
  ): Promise<void> {
    if (generation !== state.generation) return
    const ids = new Set(discovered.map((model) => model.modelId))
    if (ids.size !== discovered.length) {
      console.error(
        `${LOG_PREFIX} model discovery for ${state.cwd} returned duplicate model ids; catalog left unchanged`,
      )
      return
    }
    cancelRetry(state)
    state.snapshot = discovered
    await context.provider.reload()
  }

  function probeDeadline(
    generation: number,
    probe: Promise<readonly ModelWithEfforts[]>,
  ): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.probeTimer === timer) state.probeTimer = undefined
        void probe.then((models) => publish(generation, models)).catch(() => {})
        reject(new Error(`no response after ${DISCOVERY_TIMEOUT_MS / 1000}s`))
      }, DISCOVERY_TIMEOUT_MS)
      state.probeTimer = timer
      const settled = (): void => {
        clearTimeout(timer)
        if (state.probeTimer === timer) state.probeTimer = undefined
      }
      probe.then(settled, settled)
    })
  }

  function scheduleRetry(generation: number, attempt: number, delay: number): void {
    cancelRetry(state)
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      void retry(generation, attempt).catch(() => {})
    }, delay)
  }

  async function runDiscovery(generation: number, attempt: number): Promise<void> {
    try {
      const { listModels } = await import("kiro-acp-ai-provider")
      const probe = listModels({ cwd: state.cwd })
      const models = await Promise.race([probe, probeDeadline(generation, probe)])
      await publish(generation, models)
    } catch (error) {
      if (generation !== state.generation) return
      const delay = RETRY_BACKOFF_MS[attempt]
      const next =
        delay === undefined
          ? "giving up until the next credential change"
          : `retrying in ${delay / 1000}s`
      console.error(
        `${LOG_PREFIX} model discovery failed for ${state.cwd} (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}): ${describeError(error)}; ${next}`,
      )
      if (delay !== undefined) scheduleRetry(generation, attempt + 1, delay)
    }
  }

  function start(attempt: number): Promise<void> {
    const generation = ++state.generation
    const run = runDiscovery(generation, attempt).finally(() => {
      if (state.inflight === run) state.inflight = undefined
    })
    state.inflight = run
    return run
  }

  async function retry(generation: number, attempt: number): Promise<void> {
    if (generation !== state.generation) return
    const active = await context.integration.connection.active(KIRO_INTEGRATION_ID)
    if (!active || generation !== state.generation) return
    await start(attempt)
  }

  return async function discover(_reason: string): Promise<void> {
    const active = await context.integration.connection.active(KIRO_INTEGRATION_ID)
    if (!active) {
      cancelRetry(state)
      state.generation += 1
      state.snapshot = undefined
      await context.provider.reload()
      return
    }
    if (state.inflight) return state.inflight
    cancelRetry(state)
    return start(0)
  }
}

function isKiroCredentialEvent(event: ServerEvent): boolean {
  const type: string = event.type
  if (type === "integration.connection.updated") {
    return (event as { data?: { integrationID?: unknown } }).data?.integrationID === KIRO_INTEGRATION_ID
  }
  if (type === "credential.switched") {
    return asString((event as { data: { integrationID: unknown } }).data.integrationID) === KIRO_INTEGRATION_ID
  }
  return type === "credential.updated"
}

async function consumeEvents(
  events: AsyncIterable<ServerEvent>,
  discover: (reason: string) => Promise<void>,
): Promise<void> {
  try {
    for await (const event of events) {
      if (isKiroCredentialEvent(event)) void discover(event.type).catch(() => {})
    }
  } catch {
    // Aborting the subscription during cleanup is expected.
  }
}

export async function registerDiscovery(
  context: Plugin.Context,
  resources: DiscoveryResources,
  options: KiroPluginOptions,
): Promise<() => Promise<void>> {
  const state: DiscoveryState = {
    cwd: asString(context.location.directory),
    options,
    snapshot: undefined,
    generation: 0,
    inflight: undefined,
    probeTimer: undefined,
    retryTimer: undefined,
  }
  resources.state = state

  const discover = createDiscover(context, state)
  const registration = await context.provider.transform((editor) =>
    applyCatalogSnapshot(editor, state),
  )
  resources.disposeTransform = registration.dispose

  const controller = new AbortController()
  resources.eventController = controller
  resources.eventTask = consumeEvents(
    context.event.subscribe({ signal: controller.signal }),
    discover,
  )

  if (options.discover && (await context.integration.connection.active(KIRO_INTEGRATION_ID))) {
    void discover("setup").catch(() => {})
  }

  return async () => {
    state.generation += 1
    clearDiscoveryTimers(state)
    resources.eventController?.abort()
    resources.eventController = undefined

    const errors: unknown[] = []
    if (resources.eventTask) await resources.eventTask
    resources.eventTask = undefined

    const dispose = resources.disposeTransform
    resources.disposeTransform = undefined
    if (dispose) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, "kiro discovery cleanup failures")
  }
}
