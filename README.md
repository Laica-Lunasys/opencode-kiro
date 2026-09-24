# opencode-kiro

Use Amazon Kiro models in OpenCode v2 through the official `kiro-cli` Agent Client
Protocol (ACP) interface.

This is a public fork of
[`NachoFLizaur/opencode-kiro`](https://github.com/NachoFLizaur/opencode-kiro), updated
for the stable OpenCode v2 plugin API. It keeps authentication and model execution
inside Kiro CLI: the plugin does not scrape, copy, or proxy AWS credentials.

## Features

- Official local transport through `kiro-cli acp`
- Kiro CLI login integration in `opencode auth login`
- Automatic model discovery from Kiro's live ACP runtime
- Newly released models are added even before OpenCode's static catalog catches up
- Native Kiro reasoning-effort variants when the runtime reports them
- Kiro credit and stall status in the OpenCode TUI
- No local HTTP gateway or background service
- The same install works on macOS and Linux

## Requirements

- OpenCode `2.0.16` or a compatible v2 release
- Kiro CLI `2.15.0` or newer on `PATH`
- A Kiro subscription or supported AWS/Builder ID account

See [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) for exact build pins.

## Quick start (macOS and Linux)

Authenticate Kiro CLI first:

```bash
kiro-cli login
kiro-cli whoami
```

Install this public fork into OpenCode's global plugin directory:

```bash
PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-kiro"
git clone --depth 1 https://github.com/Laica-Lunasys/opencode-kiro.git "$PLUGIN_DIR"
npm --prefix "$PLUGIN_DIR" ci --omit=dev --ignore-scripts
```

OpenCode discovers immediate package directories under `~/.config/opencode/plugins/`
automatically, so the default setup needs no config edit. `XDG_CONFIG_HOME` is honored
on both Linux and macOS.

Then register the existing Kiro CLI session with OpenCode:

```bash
opencode auth login
```

Select **Kiro**, then **Kiro CLI Login**. If Kiro CLI is already authenticated, this
completes immediately.

List models and run one:

```bash
opencode models
opencode run --model kiro/claude-opus-5 "Reply with OK"
```

Update the checkout later with:

```bash
git -C "$PLUGIN_DIR" pull --ff-only
npm --prefix "$PLUGIN_DIR" ci --omit=dev --ignore-scripts
```

OpenCode's v2 documentation also supports npm-compatible Git targets such as
`github:Laica-Lunasys/opencode-kiro#main`. OpenCode 2.0.16 can report
`git dep preparation failed` for Git targets on some systems; the checkout method
above avoids that installer path and is the verified option.

## Configuration

No configuration is required for the default global checkout. To pass options,
reference that checkout from `~/.config/opencode/opencode.jsonc` (the relative path is
resolved from the config file):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/opencode-kiro"]
}
```

Options use the object form:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/opencode-kiro",
      "options": {
        "agent": "opencode",
        "mcpTimeout": 45,
        "discover": true,
        "stall": { "afterMs": 10000, "live": "reasoning" }
      }
    }
  ]
}
```

| Option | Default | Description |
|---|---:|---|
| `agent` | `"opencode"` | Kiro CLI agent name |
| `mcpTimeout` | `45` | MCP tool timeout in minutes |
| `discover` | `true` | Discover models during plugin startup |
| `stall.afterMs` | SDK default (`10000`) | Silence threshold in milliseconds; `0` disables it |
| `stall.live` | SDK default (`"reasoning"`) | `"reasoning"` or `"off"` |

The working directory is always taken from the OpenCode plugin location. There is no
hard-coded home directory and no `cwd` option, so the same configuration is portable
between Linux and macOS.

The package's `./tui` export is loaded automatically by OpenCode v2. Do not add a
separate entry to `cli.json`.

## Model synchronization

At startup, and again after Kiro credential changes, the plugin asks
`kiro-acp-ai-provider` for the model list exposed by the local Kiro ACP runtime. That
runtime list is authoritative.

For each model:

1. Matching OpenCode catalog metadata is retained when available.
2. Models missing from the static catalog are created with safe defaults.
3. The exact runtime model ID is exposed as `kiro/<model-id>`.
4. Runtime effort levels become OpenCode model variants.

This fixes the common case where `kiro-cli chat --list-models --format json` already
shows a model such as `claude-opus-5`, but an older OpenCode catalog only lists
`claude-opus-4.6`.

Discovery is fail-open: the last successful list remains active if a refresh fails.
A stalled probe times out after 60 seconds and retries after 5, 20, and 60 seconds.
Diagnostics use the `[opencode-kiro]` prefix.

## How it works

- **Authentication:** `verifyAuthAsync()` asks Kiro CLI whether it is authenticated.
  OpenCode stores only a non-secret presence credential.
- **Models:** `listModels()` reads the models and effort levels exposed by ACP.
- **Generation:** `createKiroAcp()` translates AI SDK calls into JSON-RPC messages for
  a local `kiro-cli acp` subprocess.
- **Tools:** tool calls are relayed through the provider's local MCP bridge and still
  execute under OpenCode's permission model.
- **Credits:** provider state is rendered by the package's optional TUI entry.

There is no credential reuse against another provider and no network gateway added by
this plugin. Requests still reach the Kiro service through Kiro CLI and remain subject
to AWS/Kiro terms and account limits.

## Troubleshooting

**`kiro-cli is not installed`**

Ensure `kiro-cli --version` works in the same terminal that launches OpenCode.

**Kiro is authenticated but no models appear**

Run `opencode auth login` and select Kiro. Then restart OpenCode or trigger a plugin
reload. Check stderr for `[opencode-kiro]` discovery messages.

**A model appears in Kiro CLI but not OpenCode**

Confirm this fork is active with `opencode plugin list`, then compare:

```bash
kiro-cli chat --list-models --format json
opencode models
```

**Migrating from a manual `kiro-acp` provider**

Remove the manual provider block after this plugin is working, otherwise both provider
IDs may appear. This plugin uses the canonical `kiro/<model-id>` namespace.

## Development

```bash
git clone https://github.com/Laica-Lunasys/opencode-kiro.git
cd opencode-kiro
npm ci
npm run check
npm pack --dry-run
```

The tests mock Kiro CLI and do not consume credits. A live smoke test requires a real
Kiro login:

```bash
opencode run --model kiro/claude-opus-5 "Reply with LIVE_OK"
```

## Security and status

This is an unofficial community plugin, not an AWS product. Review
[SECURITY.md](./SECURITY.md) before use. Report vulnerabilities through GitHub's
private security advisory flow; do not include credentials or tokens in reports.

## License

MIT. Original work © Nacho F. Lizaur; stable OpenCode v2 fork maintained by
Laica-Lunasys. See [LICENSE](./LICENSE).
