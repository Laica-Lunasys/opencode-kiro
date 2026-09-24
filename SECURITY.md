# Security Policy

## Supported versions

Security fixes are made on the latest Laica-Lunasys OpenCode v2 release. The upstream
`0.4.x` v1 and `0.5.0-beta.x` histories are retained for attribution but are not
maintained by this fork.

## Scope and threat model

This plugin does not store or transmit AWS credentials itself. Authentication is
delegated to the official `kiro-cli`, which owns the platform-specific credential
store and refresh flow. The plugin calls Kiro CLI's `whoami` behavior through
`verifyAuthAsync()` and stores only a non-secret OpenCode presence record. It does not
read OpenCode's private auth files or Kiro/AWS token files.

Prompts and tool definitions are sent to a locally spawned `kiro-cli acp` process over
stdio and a local IPC bridge. From there, Kiro CLI communicates with the Kiro service
under AWS/Kiro policies. The plugin does not add an HTTP proxy, telemetry endpoint, or
credential reuse against another provider.

Like OpenCode itself, plugins and agent tools are not a security sandbox. Tool calls
remain subject to OpenCode's permission model, and users should review requested
operations before approval.

Out of scope:

| Area | Report to |
|---|---|
| Kiro CLI or Kiro service behavior | AWS/Kiro |
| AWS handling of prompts or account data | AWS |
| OpenCode core, plugin loader, or permissions | OpenCode |
| User-controlled local configuration | The configuration owner |

## Reporting a vulnerability

Use the repository's **Security** tab and **Report a vulnerability** to submit a
private GitHub security advisory:

<https://github.com/Laica-Lunasys/opencode-kiro/security/advisories/new>

Do not open a public issue for an undisclosed vulnerability. Include the affected
version, impact, and reproducible steps, but remove credentials, account identifiers,
and prompt data.
