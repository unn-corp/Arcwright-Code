# Hairline bundle boundary

The CLI's explicit `hairline` command embeds the pinned MIT adaptation as a JSON payload so native
CLI, npm and desktop server bundles use the same bytes without runtime downloads. The source is
in `apps/server/src/skills/hairline/bundle`; `scripts/generate-hairline-bundle.mjs --check` checks
payload freshness. `PROVENANCE.json` records all 14 upstream skill file hashes, the reviewed commit,
adaptation notes and shipped file hashes; LICENSE preserves Lucas Marques's copyright.

There is no new cross-provider catalog or startup hook. Installation explicitly selects Codex's
`.agents/skills` or Claude's `.claude/skills` in an existing Git workspace. Native discovery and
invocation stay provider-owned. The command refuses existing Hairline directories and symlinked
ancestors. It does not change disabled settings, install in homes, or override user skill precedence.
Other providers are unsupported. Optional dependent `hairline-adopt` is omitted.

Generated figures are never evaluated by helpers. `look.mjs` always fails closed, before any file
read, browser launch, package installation or network request. There is no supported isolated
preview runner in this integration. Adding one requires a pinned existing tool inside an OS-level
credential-free network-denied boundary, blocked navigation/downloads/service workers and explicit
CPU/memory/process/time/output limits. A fresh browser profile, request routing, offline mode or
regex lint alone is not that boundary.

Build and SVG-card helpers only read bounded regular, non-symlink, single-link files in a private
owned artifact run and create exclusive named outputs there. Every path ancestor is checked.
The threat model excludes hostile concurrent processes with the same OS identity changing checked
ancestors, compromised hosts and arbitrary agent shell writes; portable Node path checks do not
provide race-proof directory handles. Source SVG is never rendered; lexical metadata is truncated,
control-filtered and JSON-escaped, explicitly labeled untrusted data. This is exposure reduction,
not a prompt-injection proof. No XML entity expansion occurs. The regex validator is quality lint
and uses Node's parse-only check with an empty environment and bounded subprocess time/output.
It never establishes code safety or visual correctness.

Install is exclusive, not an updater. An interrupted install remains inspectable and prevents retry
from overwriting files. Removal is explicit and project-local. Tests must use owned disposable Git
workspaces; never real provider homes or running sessions.

Verification currently covers Linux. Native Windows ACL confinement and macOS execution are not
established; POSIX private-mode checks can refuse unsupported filesystems rather than silently
claim confinement. Native desktop/executable packaging remains CI validation.
