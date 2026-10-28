# Organization CI runners

All jobs use the shared organization pool on Mothership. There is no GitHub-hosted
or Blacksmith fallback. The dedicated T3 runner group and its two Linux workers
and Windows VM supervisor are retired; do not provision replacement `t3-ci` workers.

| Pool    | Required labels                               | Capacity and prerequisites                                                                                                                                 |
| ------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `self-hosted, linux, x64, unn, unn-isolated`  | Three Dokploy slots: `unn-isolated-1`, `unn-isolated-2`, `unn-isolated-3`. Each has 8 CPUs, 16 GiB, a fresh workspace/home per job, private DinD, and KVM. |
| Windows | `self-hosted, windows, x64, unn, unn-windows` | The organization-wide `unn-runner-win` service on the existing `win2022` VM, with MSVC, Git Bash, PowerShell 7, Node, Python, and GitHub CLI.              |

`unn-isolated` describes disposable Linux containers. The Windows VM also hosts IIS
and unrelated workloads and is persistent; it must not carry that label. External
pull-request documentation checks select Linux only. Windows jobs run trusted pushes,
manual diagnostics, and release workflows. Review any change that adds a public PR
Windows job before enabling it. Never reset the shared VM or remove its existing data.

The `Default` runner group admits organization repositories, including the public
`unn-corp/Arcwright-Code` and `unn-corp/Arcwright-AI` repositories. The Windows service keeps
organization scope. `unn-windows` selects this VM without pretending it is disposable.

Dokploy's Services project owns the three Linux supervisors. They use the existing
T3 Ubuntu 24.04 toolchain image, pinned by image ID
`sha256:0a477a294b01590de1fddddface30213798fb4eba28c3d6706b01c5ed594d6de`,
for prepare, registration, and job containers. The image source and immutable SDK/VM
seeds remain under [infra/ci/linux](../../infra/ci/linux/README.md). This source is
retained for shared image maintenance; its old dedicated-slot provisioning examples
must not recreate a separate fleet. Preserve nonroot UID/GID 1001:121, read-only root,
no-new-privileges, empty capabilities, and isolation from host Docker/registration
secrets. Private DinD provides Docker; only infrastructure supervisors see the host socket.

The shared Linux image supplies Java 17, Android API 36 SDK/emulator, QEMU, the C/C++
toolchain, pkg-config, libsecret/Wayland headers, ImageMagick, and desktop runtime
libraries. KVM and its supplemental group are passed through by the slot definition.
Do not add sudo or make the root filesystem writable. The infrastructure-owned
`t3-ci-start-runner` and `t3-ci-preflight` names remain toolchain entrypoints; they do
not require dedicated T3 runner registrations or labels.

Keep `reactivecircus/android-emulator-runner` at v2.37.0 in the fork release and
package-diagnostic workflows. v2.38.0 changes the default Build Tools package to
37.0.0, while the shared image and app build use 36.0.0; this pin preserves that
toolchain alignment without changing API 36 or emulator validation.

The fork supports Linux x64 and Windows x64. It has no macOS or hardware ARM64 capacity.
Preserve guards on macOS native analysis, the macOS preview pipeline, iOS screenshots,
and native ARM64 desktop/CLI jobs. Android target ABIs are independent of host CPU
architecture, so Android ARM64 APK support remains enabled on Linux x64.

The former dedicated Windows base image remains recovery material only. Do not start
its retired supervisor or reset the organization Windows VM from that template.

Use a current GitHub Actions runner compatible with the workflows' Node-based action versions.
Tool-cache and package-cache directories must be writable. Vite+, Java, Rust, and Gradle setup
remain in the workflows; these do not supply native OS compilers or emulator hardware.
Native package dependencies must be present in the shared isolated image. CI and release jobs verify the C/C++ toolchain and libsecret headers with
`verify-native-build-deps`; they do not install packages or wait for background APT work. The APT mirror
helper skips hardened workers; on writable Ubuntu workers it uses architecture-specific HTTPS
mirrors without assuming a hosted image's `ubuntu.sources` file. Do not add sudo or make the
existing pool's root filesystem writable to run these workflows.

Fork release jobs install only the source workspaces their commands use, plus the root workspace
for Vite+ tooling referenced by the root configuration. The root package has no workspace
dependencies, so selecting it does not pull in the standalone upstream Expo app in `apps/mobile`.
The recovery-helper builder bundles `packages/shared` with Vite+, so its source checkout also
installs `@t3tools/shared` and its workspace dependencies. The release and diagnostic safety
suites install the server, desktop, web, and scripts workspaces and their dependencies; this includes
`packages/shared` through those dependencies and the web workspace needed to prepare the fork's
Android PWA tests. The Expo app's native dependencies add substantial install time without
supporting these release commands. The release suites and their required test files remain
unchanged.

Linux workers must set `TMPDIR` to an executable directory under their disposable workspace,
such as `/_work/_temp`, and create it for the runner user before accepting work. The hardened
pool's `/tmp` is mounted with `noexec`; compiler fixtures and native helper tests must use the
executable per-job temporary directory instead. CI tests and fork release build/validation jobs
export TMPDIR from RUNNER_TEMP for subsequent steps, so shared pool defaults cannot send
executable fixtures to /tmp. Keep its lifecycle tied to the job and disposable worker.
Cached per-file tests also pass TMPDIR through Vite+'s environment filter without fingerprinting
this job-specific scratch location.
The dependency action caches the resolved Linux Vite+ home because the pool links its home
directory into the disposable workspace; a symlink-only cache is not an installed toolchain.
A cache without an executable vp uses the same pinned setup action as an ordinary cache miss.

Relay account-deletion and managed-endpoint SQL tests use a disposable PostgreSQL 16.14 cluster owned by the
test job, with TCP disabled and a private Unix socket. `setup-test-postgres` caches only
native tools built from the checksummed upstream source; compilation uses the image's
existing toolchain without sudo, Docker, or a system install. `with-relay-postgres.py`
creates the cluster, runs the test command, then stops and removes its owned resources,
including after command failure or cancellation. Database state and credentials never
enter the cache. The relay suite runs files serially because these tests reset shared
test schemas. Fixture admission verifies directory/socket ownership and the connected
database's data directory before allowing their separately bounded schema resets; ambient database URLs
are never accepted. The existing separately authorized Docker fixture remains supported.

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
missing shared-pool labels, or unexpected skipped prerequisites fail it. Then run representative
Linux, Windows x64, and Android jobs on actual workers before claiming those capabilities ready.
Queued enabled jobs indicate missing labels, capacity, or group access; disabled macOS/ARM64 jobs
must appear skipped instead.

This migration does not enable publishing. Existing repository, environment, and release gates
remain authoritative. The retained upstream EAS workflows remain guarded off for this fork;
if separately enabled elsewhere, their native build commands still dispatch work to Expo's build service.
