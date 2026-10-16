# Organization CI runners

Every GitHub Actions job in `unn-corp/t3code` requires `self-hosted`, `unn`, `unn-isolated`, and
`t3-ci`, plus its operating system and CPU architecture. This covers checks, releases,
diagnostics, screenshots, and repository automation, including retained upstream workflows
that are guarded off in this fork. There is no GitHub-hosted or Blacksmith fallback: enabled
jobs wait for a matching dedicated T3 worker.

`unn-isolated` is a provisioning contract. Apply it only to disposable workers with a fresh
workspace and home, no persistent credentials, and no access to production or developer data.
Destroy the worker after its job. Public pull requests execute dependency scripts and tests;
shared persistent organization workers must not receive this label. Signing and publishing
jobs also need isolated workers, with secrets supplied only to the authorized job.

## Capacity and repository access

The fork supports **Linux x64 and Windows x64 workers**. It has no macOS or hardware ARM64
capacity. Repository guards disable macOS native analysis and its change detector, the complete
macOS preview pipeline, iOS screenshot capture, and native ARM64 desktop/CLI jobs on this fork.
The retained upstream paths remain available outside `unn-corp/t3code`. `Check` accepts the
fork's two deliberately skipped mobile native jobs; every enabled prerequisite must still pass.

Android APK builds and emulator checks remain enabled on Linux x64. This hardware policy does
not remove ARM64 APK support: Android target ABIs and the runner's CPU architecture are separate.

Use the dedicated `T3 Code` organization runner group, restricted to `unn-corp/t3code`. The
`t3-ci` label prevents these jobs from landing on the existing three Mothership organization
workers. Those workers use a hardened Ubuntu 20.04 image, UID 1001, a read-only root filesystem,
and no sudo; keep their image, storage, and workloads unchanged. Provision dedicated T3 workers
instead of relabeling shared workers or relaxing their controls.

| Required labels in addition to `self-hosted, unn, unn-isolated, t3-ci` | Jobs and worker prerequisites                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `linux, x64`                                                           | General checks, Linux desktop builds, Android builds, and emulator validation. Bake Git, GitHub CLI, jq, curl, unzip, Python, a C/C++ toolchain, pkg-config, libsecret development headers, ImageMagick, and desktop runtime libraries into a dedicated Ubuntu 24.04 isolated image. |
| `windows, x64`                                                         | Windows tests, desktop packaging, recovery helpers, and safety/receipt validation. Use a clean disposable Windows CI template with Git Bash, PowerShell, and MSVC build tools.                                                                                                       |

The shared `win2022` VM hosts IIS, other repository runner data, and unrelated workloads. It is
not an eligible T3 CI worker. Prepare a separate clean template and destroy each job's VM,
workspace, and runner registration rather than executing T3 jobs on that shared machine.

The dedicated infrastructure lives on **Mothership**, reached through the configured
`mothership` SSH alias. Dokploy's **T3 Code CI** project owns two Linux slot supervisors and
one Windows VM supervisor in its production environment. Each job receives a new worker;
the organization runner names therefore change or re-register between jobs.

Linux slots each have 8 CPUs and 16 GiB RAM, a private workspace, executable temporary storage,
and KVM access. Their job containers have no Docker daemon or host socket. See the
[Linux image and supervisor setup](../../infra/ci/linux/README.md) for immutable image builds,
rendering, network controls, and cleanup. Windows uses a separate `t3-ci-windows-base` template
and fresh 8-CPU, 16-GiB overlays; see the
[Windows provisioning and admission procedure](../../infra/ci/windows/README.md).

The `T3 Code` group admits only this fork. The shared `Default` group retains its original
all-private-repository access and does not admit this public fork.

Use a current GitHub Actions runner compatible with the workflows' Node-based action versions.
Tool-cache and package-cache directories must be writable. Vite+, Java, Rust, and Gradle setup
remain in the workflows; these do not supply native OS compilers or emulator hardware.
Native package dependencies must be present in the dedicated isolated image. The APT mirror
helper skips hardened workers; on writable Ubuntu workers it uses architecture-specific HTTPS
mirrors without assuming a hosted image's `ubuntu.sources` file. Do not add sudo or make the
existing pool's root filesystem writable to run these workflows.

Fork release jobs install only the source workspaces their commands use, plus the root workspace
for Vite+ tooling referenced by the root configuration. The root package has no workspace
dependencies, so selecting it does not pull in the standalone upstream Expo app in `apps/mobile`.
The recovery-helper builder bundles `packages/shared` with Vite+, so its source checkout also
installs `@t3tools/shared` and its workspace dependencies. The release safety suites install the
server, desktop, web, and scripts workspaces and their dependencies; this includes
`packages/shared` through those dependencies and the web workspace needed to prepare the fork's
Android PWA tests. The Expo app's native dependencies add substantial install time without
supporting these release commands. The release suites and their required test files remain
unchanged.

Linux workers must set `TMPDIR` to an executable directory under their disposable workspace,
such as `/_work/_temp`, and create it for the runner user before accepting work. The hardened
pool's `/tmp` is mounted with `noexec`; compiler fixtures and native helper tests must use the
executable per-job temporary directory instead. Keep its lifecycle tied to the worker.

Android workers must provide SDK command-line tools, `ANDROID_HOME`, and a writable SDK directory.
The workflows use that existing `sdkmanager` to install SDK packages; they do not bootstrap it.
Emulator workers additionally need an accessible `/dev/kvm`, virtualization support, and
permission to use KVM. The Mothership host has KVM, but a container worker still needs the device
passed through; an organization label alone does not provide it. The retained AUR workflow
uses a Docker job container and requires a working Docker service with the job workspace
available to that service; it remains guarded off in this fork.

The reusable desktop workflow takes an OS label in `runner` and a host architecture in
`runner_arch`; the mandatory fleet and isolation labels are added by the callee. Callers cannot
select a hosted or unrelated organization worker through those inputs. On this fork the callee
also rejects macOS and ARM64 host or desktop targets, even if a caller omits its own capacity
guard. Native CLI smoke tests must run on their matching architecture.

## Verification

Before admitting the fleet, run workflow lint and the focused `scripts/ci-runners.test.ts` and
`scripts/fork-release-workflows.test.ts` suites. The policy checks every runner matrix and
reusable caller, the unsupported-platform guards, and Check's actual shell gate. Hosted selectors,
missing dedicated-pool labels, or unexpected skipped prerequisites fail it. Then run representative
Linux, Windows x64, and Android jobs on actual workers before claiming those capabilities ready.
Queued enabled jobs indicate missing labels, capacity, or group access; disabled macOS/ARM64 jobs
must appear skipped instead.

This migration does not enable publishing. Existing repository, environment, and release gates
remain authoritative. The retained upstream EAS workflows remain guarded off for this fork;
if separately enabled elsewhere, their native build commands still dispatch work to Expo's build service.
