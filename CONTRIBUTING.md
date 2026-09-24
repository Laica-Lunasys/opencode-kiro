# Contributing

This repository is a public OpenCode v2 fork. Bug reports and focused fixes are
welcome; upstream submission is not required.

## Setup

```bash
git clone https://github.com/Laica-Lunasys/opencode-kiro.git
cd opencode-kiro
npm ci
npm run check
```

Requirements:

- Node.js 20 or newer for development
- Bun 1.3 or newer for OpenCode-compatible package installation
- Kiro CLI only for live smoke tests

Unit tests mock Kiro CLI and do not consume Kiro credits.

## Checks

```bash
npm run typecheck
npm test
npm pack --dry-run
```

Keep dependency versions exact where the OpenCode, OpenTUI, or ACP contracts are
version-sensitive. Update `docs/COMPATIBILITY.md` and `CHANGELOG.md` with any pin.

## Local OpenCode test

Build the package and configure its directory directly:

```bash
npm run build
```

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-kiro"]
}
```

Or install the public Git target:

```bash
opencode plugin add github:Laica-Lunasys/opencode-kiro#main
```

A live test requires `kiro-cli login`, followed by `opencode auth login` and a Kiro
model request. Never commit credentials, auth caches, generated tarballs, or Kiro log
files.

## Style

- Keep transforms synchronous and free of I/O.
- Perform model discovery outside transforms and call `provider.reload()` afterward.
- Derive working directories from `context.location`.
- Avoid OS-specific paths; code must work on macOS and Linux.
- Add tests for behavior changes and cleanup paths.
