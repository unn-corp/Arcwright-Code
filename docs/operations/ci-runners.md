# Organization CI runners

Every GitHub Actions job in `unn-corp/t3code` requires the labels `self-hosted`, `unn`, and
`unn-isolated`, plus its operating system and CPU architecture. This covers checks, releases,
diagnostics, previews, screenshots, and repository automation, including retained upstream
workflows guarded off in this fork. There is no GitHub-hosted or Blacksmith fallback: jobs wait
for a matching organization worker.

`unn-isolated` is a provisioning contract. Apply it only to disposable workers with a fresh
workspace and home, no persistent credentials, and no access to production or developer data.
Destroy the worker after its job. Public pull requests execute dependency scripts and tests;
shared persistent organization workers must not receive this label. Signing and publishing
jobs also need isolated workers, with secrets supplied only to the authorized job.

## Capacity and repository access

The Mothership organization pool currently supplies Linux x64 workers with a hardened Ubuntu 20.04
image, UID 1001, a read-only root filesystem, and no sudo. Keep those controls intact. This does
not establish isolated worker provisioning, the other native platforms, or permission to run
this public repository.
On 2026-10-14, the organization's Default runner group granted this public repository access.
Its selected-repository policy preserves all existing private repositories and includes only
`unn-corp/t3code` among public repositories. New repositories must be added explicitly.
Repository access is commissioned; the additional platform and native-tool capabilities below
still require provisioning. Do not relabel shared workers to bypass isolation requirements.

| Required labels in addition to `self-hosted, unn, unn-isolated` | Jobs and worker prerequisites                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linux, x64`                                                    | General checks and tooling, Linux desktop builds, Android builds and emulator validation. Bake Git, GitHub CLI, jq, curl, unzip, Python, a C/C++ toolchain, pkg-config, libsecret, and desktop runtime libraries into a dedicated isolated image.                                                 |
| `linux, arm64`                                                  | Native ARM64 Linux desktop and CLI builds. Supply the same native build dependencies and ARM64 hardware.                                                                                                                                                                                          |
| `windows, x64`                                                  | Windows tests, desktop packaging, recovery helpers, and Windows safety/receipt validation. Install Git Bash, PowerShell, and MSVC build tools.                                                                                                                                                    |
| `windows, arm64`                                                | Native Windows ARM64 desktop and CLI builds. Install ARM64 native build tooling and PowerShell; the workflow selects its pinned PowerShell version.                                                                                                                                               |
| `macOS, arm64`                                                  | Apple Silicon desktop and CLI builds, mobile native static analysis, and iOS screenshots. Install Xcode with the required simulator runtimes and Homebrew; jobs install SwiftLint, ktlint, detekt, and screenshot tools. The Intel macOS DMG is cross-packaged here without an Intel CLI archive. |

Use a current GitHub Actions runner compatible with the workflows' Node-based action versions.
Tool-cache and package-cache directories must be writable. Vite+, Java, Rust, and Gradle setup
remain in the workflows; these do not supply native OS compilers or emulator hardware.
Native package dependencies must be present in the dedicated isolated image. The APT mirror
helper skips hardened workers; on writable Ubuntu workers it uses architecture-specific HTTPS
mirrors without assuming a hosted image's `ubuntu.sources` file. Do not add sudo or make the
existing pool's root filesystem writable to run these workflows.

Android workers must provide SDK command-line tools, `ANDROID_HOME`, and a writable SDK directory.
The workflows use that existing `sdkmanager` to install SDK packages; they do not bootstrap it.
Emulator workers additionally need an accessible `/dev/kvm`, virtualization support, and
permission to use KVM. The Mothership host has KVM, but a container worker still needs the device
passed through; an organization label alone does not provide it. A Windows VM is present on the
host, but no Windows organization runner or macOS/ARM workers have been commissioned for this
repository. The retained AUR workflow uses a Docker job container and requires a working Docker
service with the job workspace available to that service.

The reusable desktop workflow takes an OS label in `runner` and a host architecture in
`runner_arch`; the mandatory organization and isolation labels are added by the callee. Callers
cannot select a GitHub-hosted machine through that input. Native CLI smoke tests must run on
their matching architecture.

## Verification

Before admitting the fleet, run workflow lint and the focused `scripts/ci-runners.test.ts` and
`scripts/fork-release-workflows.test.ts` suites. The runner policy checks every workflow, matrix
choice, conditional JSON matrix branch, and reusable desktop caller; hosted selectors or missing
organization/isolation labels fail it. Then run representative Linux, Windows, macOS, and Android
jobs on actual workers before claiming those platform capabilities ready. Queued jobs indicate
missing labels, capacity, or runner-group access rather than permission to use a hosted fallback.

This migration does not enable publishing. Existing repository, environment, and release gates
remain authoritative. The retained upstream EAS workflows remain guarded off for this fork;
if separately enabled, their native build commands still dispatch work to Expo's build service.
