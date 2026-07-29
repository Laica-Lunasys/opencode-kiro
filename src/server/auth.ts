// Integration `kiro` + Credential OAuth auth flow (v2, task 05).
//
// Auth authority is `verifyAuth()` from kiro-acp-ai-provider (delegates to
// kiro-cli). OpenCode never stores real AWS tokens: the Credential.OAuth we
// return is a minimal presence record (`access: "kiro-cli"`, `expires: 0`) and
// we deliberately do NOT implement the Integration refresh callback —
// kiro-cli owns credential storage and refresh.
//
// The SDK import stays lazy so dist/server.js loads under plain Node without
// touching kiro-acp-ai-provider at module import time (v1 discipline).
import type { Credential, Integration, Plugin } from "@opencode-ai/plugin"
import type { ChildProcess } from "node:child_process"

export const KIRO_INTEGRATION_ID = "kiro"
export const KIRO_INTEGRATION_NAME = "Kiro"
export const KIRO_OAUTH_METHOD_ID = "kiro-cli-login"
export const KIRO_OAUTH_METHOD_LABEL = "Kiro CLI Login"

// truthful docs URL for attempt display (v1 install-guidance URL; the login
// browser window is opened by kiro-cli itself — we never invent a callback URL)
export const KIRO_DOCS_URL = "https://kiro.dev/docs/cli/"

// v1 poll cadence/limits — keep exact values
const POLL_INTERVAL_MS = 2_000
const MAX_WAIT_MS = 120_000

const NOT_INSTALLED_MESSAGE = "kiro-cli is not installed. Install it from https://kiro.dev/docs/cli/"
const TIMEOUT_MESSAGE =
  "Kiro authentication timed out. Run `kiro-cli login` manually, then re-run `opencode auth login`."
const LOGIN_INSTRUCTIONS =
  "Complete Kiro authentication in the browser window that just opened. Waiting for login..."
const ALREADY_AUTHENTICATED_INSTRUCTIONS = "Already authenticated with Kiro CLI."
// consent "yes" no longer writes any host config file (deleted v1 behavior):
// it only surfaces manual global cli.json guidance (plural `plugins`, per v2 config)
const SIDEBAR_INSTRUCTIONS =
  'To enable the Kiro credits sidebar, add "opencode-kiro" to the "plugins" array in your global cli.json and restart opencode.'

// login-flow resources tracked for task 07's aggregated cleanup: the spawned
// kiro-cli child, the poll timer, the pending-poll canceller (settles the
// attempt promise on disposal so nothing awaits forever), and the integration
// registration disposer.
export interface AuthResources {
  child: ChildProcess | undefined
  pollTimer: NodeJS.Timeout | undefined
  cancelPoll: (() => void) | undefined
  disposeRegistration: (() => Promise<void>) | undefined
}

export function createAuthResources(): AuthResources {
  return {
    child: undefined,
    pollTimer: undefined,
    cancelPoll: undefined,
    disposeRegistration: undefined,
  }
}

// kill the child, clear the poll timer, and settle any pending poll promise.
// idempotent; used on success, timeout, and plugin disposal.
export function releaseLoginResources(resources: AuthResources): void {
  if (resources.pollTimer !== undefined) {
    clearTimeout(resources.pollTimer)
    resources.pollTimer = undefined
  }
  if (resources.child !== undefined) {
    resources.child.kill()
    resources.child = undefined
  }
  if (resources.cancelPoll !== undefined) {
    const cancel = resources.cancelPoll
    resources.cancelPoll = undefined
    cancel()
  }
}

// minimal Credential.OAuth: no synthetic expiry (expires: 0), no copied AWS
// token data, stable non-secret `access` presence value.
function kiroCredential(): Credential.OAuth {
  return {
    type: "oauth",
    methodID: KIRO_OAUTH_METHOD_ID as Integration.MethodID,
    refresh: "",
    access: "kiro-cli",
    expires: 0,
  }
}

// structural mirror of the installed d.ts `IntegrationOAuthAuthorization`
// (dist/promise/integration.d.ts) — the type is not exported from the package
// root, so we keep a local alias that stays assignable to it.
type OAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & {
  readonly mode: "auto"
  readonly callback: Promise<Credential.OAuth>
}

function withSidebarGuidance(instructions: string, inputs: Record<string, string>): string {
  return inputs["sidebar"] === "yes" ? `${instructions}\n\n${SIDEBAR_INSTRUCTIONS}` : instructions
}

// poll verifyAuth() every 2s for up to 120s (v1 semantics). Resolves with the
// credential on success; rejects on timeout with manual-login guidance; rejects
// with a cancellation error when the plugin is disposed mid-poll.
function pollForLogin(
  verifyAuth: () => { installed: boolean; authenticated: boolean },
  resources: AuthResources,
): Promise<Credential.OAuth> {
  return new Promise<Credential.OAuth>((resolve, reject) => {
    const start = Date.now()

    resources.cancelPoll = () => {
      reject(new Error("Kiro authentication was cancelled."))
    }

    const tick = (): void => {
      resources.pollTimer = undefined
      if (verifyAuth().authenticated) {
        // disarm the canceller BEFORE releasing so release cannot settle the
        // attempt as cancelled ahead of the real resolution
        resources.cancelPoll = undefined
        releaseLoginResources(resources)
        resolve(kiroCredential())
        return
      }
      if (Date.now() - start >= MAX_WAIT_MS) {
        // same disarm-first ordering: timeout must reject with guidance, not
        // surface as a cancellation
        resources.cancelPoll = undefined
        releaseLoginResources(resources)
        reject(new Error(TIMEOUT_MESSAGE))
        return
      }
      resources.pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    resources.pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
  })
}

// OAuth authorize covering the five auth states:
// 1. CLI absent      -> reject with installation guidance, no credential, no spawn
// 2. already authed  -> automatic attempt resolving immediately, no spawn
// 3. unauthenticated -> spawn `kiro-cli login`, mode "auto", poll 2s/<=120s
// 4. success         -> kill child, resolve Credential.OAuth
// 5. timeout/cancel/disposal -> kill child, clear timer; timeout carries
//    manual-login guidance
async function authorize(
  inputs: Record<string, string>,
  resources: AuthResources,
): Promise<OAuthAuthorization> {
  const { verifyAuth } = await import("kiro-acp-ai-provider")
  const status = verifyAuth()

  if (!status.installed) throw new Error(NOT_INSTALLED_MESSAGE)

  if (status.authenticated) {
    return {
      url: KIRO_DOCS_URL,
      instructions: withSidebarGuidance(ALREADY_AUTHENTICATED_INSTRUCTIONS, inputs),
      mode: "auto",
      callback: Promise.resolve(kiroCredential()),
    }
  }

  const { execFile } = await import("node:child_process")
  // shell:true on win32 so bare "kiro-cli" resolves via PATHEXT to .exe/.cmd
  // (matches the SDK's spawns); shell:false elsewhere
  resources.child = execFile("kiro-cli", ["login"], {
    shell: process.platform === "win32",
  })

  return {
    url: KIRO_DOCS_URL,
    instructions: withSidebarGuidance(LOGIN_INSTRUCTIONS, inputs),
    mode: "auto",
    callback: pollForLogin(verifyAuth, resources),
  }
}

// upsert Integration `kiro` with the "Kiro CLI Login" OAuth method via
// context.integration.transform. Returns one disposer that releases any
// in-flight login resources and unregisters the transform.
export async function registerAuth(
  context: Plugin.Context,
  resources: AuthResources,
): Promise<() => Promise<void>> {
  const registration = await context.integration.transform((draft) => {
    draft.update(KIRO_INTEGRATION_ID, (integration) => {
      integration.name = KIRO_INTEGRATION_NAME
    })
    draft.method.update({
      integrationID: KIRO_INTEGRATION_ID,
      method: {
        id: KIRO_OAUTH_METHOD_ID,
        type: "oauth",
        label: KIRO_OAUTH_METHOD_LABEL,
        prompts: [
          {
            type: "select",
            key: "sidebar",
            message: "Enable the Kiro credits sidebar?",
            options: [
              { label: "Yes", value: "yes", hint: "shows manual cli.json setup steps" },
              { label: "No", value: "no" },
            ],
          },
        ],
      },
      authorize: (inputs) => authorize(inputs, resources),
      // no refresh callback: kiro-cli owns credential storage and refresh
    })
  })
  resources.disposeRegistration = registration.dispose

  return async () => {
    releaseLoginResources(resources)
    resources.disposeRegistration = undefined
    await registration.dispose()
  }
}
