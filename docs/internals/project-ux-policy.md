# Project UX policy

`ProjectSettingsOverrides.uxGuidance` is a project-only `auto | on | off` choice.
There is deliberately no account/environment default or global instruction edit.
Omitted means automatic. Older clients that omit this new field while replacing
another project override preserve the stored choice; explicit `auto` resets it.
Removing the entire project's override record also removes the choice.

`RunExecutionService` resolves the setting for the current app thread and probes
the effective fetch origin in its current native workspace on each turn.
It does not use nullable/cached repository identity or upstream ownership.
Only exact public GitHub HTTPS and Git SSH authorities are recognized, with
complete owner/repository segments. Local remotes, aliases, nonstandard ports,
credentials, queries, encoded paths and lookalike hosts do not establish automatic
adoption. The canonical Git root must match the workspace, including real paths,
so a non-Git directory nested inside another repository cannot inherit adoption.
Multiple origin URLs fail automatic selection. Explicit On needs no origin.

## Bundled source

- Proposed source: [UNNui draft PR #18](https://github.com/unn-corp/UNNui/pull/18).
- Commit: `7d59b31594442433de9bb1b4b5b141db194edcc9`.
- Path: `docs/UNNDEV-UI-STANDARDS-CORE.md`, version 1.2.
- UTF-8 SHA-256: `ff19ffa117f1c78d1e9fd4b28ca1d7b6bdcc497ab961c6be30ee21bdf1c7571f`.
- Local audit copy: `apps/server/src/project/policies/UNNDEV-UI-STANDARDS-CORE.md`.
- Bundle module: `apps/server/src/project/policies/unnUxCore.ts`, a string
  containing those exact bytes, so executable packaging needs no external asset.

The source is proposed, not merged. The policy tests compare the audit copy with
the bundled string. Runtime verifies the entire bundled string against the pinned
hash before extracting the named 19-principle section and its evidence limits.
Missing source cannot produce a valid build; empty or altered bundled content
deactivates policy. Updates require an explicitly reviewed source, new pin and
matching bundle/audit bytes. No per-turn remote instruction fetch occurs.

## Provider boundary

`ProviderAdapterV2TurnInput.projectPolicy` is resolved by the server, separately
from MCP `appContext`. It includes project identity and active/deactivated state.
Codex uses trusted application additional context even without T3 MCP, with four
fixed, lexically ordered keys of at most 6,000 UTF-8 bytes each and a 24,000-byte
policy budget. Reserved application keys win over untrusted context. The existing
per-native-thread compaction restoration restores the current bounded values.
Fresh excluded threads receive no policy context; resumed or previously guided
threads receive explicit deactivation so prior application guidance is inactive.
Already-written provider history is not erased.

Claude keeps the native `claude_code` system preset. Project guidance follows the
existing runtime/orchestration append, while user launch text remains last.
The live query reuse key includes project identity and effective guidance, forcing
a new query when policy changes, including opt-out. Resume uses the current
append; fresh excluded sessions receive no policy append. Provider continuation
drains already-produced output from its existing process.

Other adapters ignore the new field and are not claimed to support guidance.
Native delegated UX work is instructed to carry the applicable guidance and local
constraints; backend delegates have no new UX requirements.
