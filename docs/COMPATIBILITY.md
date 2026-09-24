# Compatibility

This fork targets the stable OpenCode v2 plugin API and the official Kiro CLI ACP
transport. The versions below are exact build and test pins for `0.5.0-laica.2`.

| Component | Tested version | Notes |
|---|---:|---|
| OpenCode | `2.0.16` | Stable v2 plugin loader and provider API |
| `@opencode/plugin` | `2.0.16` | Exact runtime dependency |
| `kiro-acp-ai-provider` | `3.2.0` | Talks to `kiro-cli acp` |
| Kiro CLI | `2.15.0` | Authentication and runtime model discovery |
| Node.js | `>=20` | Build/package scripts |
| Bun | `1.3.9` | OpenCode package installation/runtime |
| `@opentui/solid` | `0.5.12` | Exact TUI runtime dependency |
| `solid-js` | `1.9.12` | Exact OpenTUI peer version |

## Operating systems

- **Linux:** tested directly on x86_64 Linux.
- **macOS:** supported without OS-specific paths or shell commands. Authentication,
  model discovery, and generation are delegated to the platform's `kiro-cli` binary.
  The auth implementation also has explicit process-spawn tests for POSIX and Windows.

Both systems require `kiro-cli` and `opencode` on `PATH`. Kiro CLI owns credentials in
the platform-appropriate store; this plugin does not read or copy them.

## Install target

Use a global plugin checkout on OpenCode 2.0.16:

```bash
PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-kiro"
git clone --depth 1 https://github.com/Laica-Lunasys/opencode-kiro.git "$PLUGIN_DIR"
npm --prefix "$PLUGIN_DIR" ci --omit=dev --ignore-scripts
```

OpenCode discovers the package directory automatically. Its documented
`github:Laica-Lunasys/opencode-kiro#main` target is also valid syntax, but the 2.0.16
installer can fail during Git dependency preparation on some systems. The checkout
path avoids that installer behavior and uses the same source export.

## Validation

```bash
npm ci
npm run check
npm pack --dry-run
```

A live smoke test additionally requires an authenticated Kiro CLI:

```bash
kiro-cli whoami
kiro-cli chat --list-models --format json
opencode models kiro
opencode run --model kiro/claude-opus-5 "Reply with OK"
```

The live Kiro model lineup can change independently of this package. The plugin reads
that runtime lineup through ACP on startup and after credential changes, then reloads
the OpenCode provider catalog.
