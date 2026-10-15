@AGENTS.md

## Packaging

For app build, packaging, installation, or update requests, follow the
[default agent delivery procedure](docs/operations/fork-releases.md#default-agent-delivery):
install the latest eligible, verified nightly containing the requested changes, or
publish a new numbered nightly from the tested, pinned source. Honor explicit user
choices and preserve running chats until native maintenance admission. Documentation
and review work alone do not commission a release.

Follow the fork's [version provenance rules](docs/operations/fork-releases.md#version-provenance-and-history).
The UI shows the included T3 base and a separate **Arcwright build** counter. Published installer
versions and Android installation codes remain immutable ordering identities; do not rename them
to change display labels.

For local packaging, use `apps/desktop/package.json`. The fork release workflow aligns package
versions in its isolated candidate checkout using `scripts/update-release-package-versions.ts`.
`T3CODE_DESKTOP_VERSION` / `--build-version` must match that checkout's aligned desktop package
version exactly. Do not override versions in a live installation or stamp ad hoc fork nicknames.
