# Disposable Windows CI workers

> The dedicated T3 fleet was retired on 2026-10-19. Use the shared organization
> runners described in [the current runbook](../../../docs/operations/ci-runners.md).
> These image sources are retained for toolchain maintenance and recovery; do not
> recreate dedicated supervisors from the historical provisioning examples.

This pool uses a clean Windows Server 2022 x64 base and creates a new VM,
qcow2 overlay, network, home, and workspace for each GitHub Actions job. It
does not reuse the shared `win2022` VM or its registered Squidhub/FCM runners.
The manager belongs to Dokploy's **T3 Code CI** project. Workers register in
the **T3 Code** organization runner group, restricted to `unn-corp/t3code` and `unn-corp/Arcwright-AI`,
with `self-hosted, Windows, X64, unn, unn-isolated, t3-ci`.

## Build the clean base

Copy `bootstrap.ps1` and `provision-base.py` to
`/home/devotek/t3-ci-windows/` on Mothership, then run there:

```bash
python3 /home/devotek/t3-ci-windows/provision-base.py \
  --windows-iso /var/lib/libvirt/images/win2022-eval.iso \
  --virtio-iso /var/lib/libvirt/images/virtio-win.iso \
  --host-ip 67.222.144.10
```

The installer creates only `t3-ci-windows-base` and its reserved storage and
network. It refuses to recreate an existing base. Never clone the live
shared Windows disk. A random local setup password is generated privately;
no GitHub credentials enter the base. The existing source media SHA-256s are:

| Media                              | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| Windows Server 2022 evaluation ISO | `3e4fa6d8507b554856fc9ca6079cc402df11a8b79344871669f0251535255325` |
| VirtIO Windows ISO                 | `e14cf2b94492c3e925f0070ba7fdfedeb2048c91eea9c5a5afb30232a3976331` |

`virt-install --wait 0` leaves the first installation reboot powered off.
Start this newly created base once to continue setup:

```bash
virsh -c qemu:///system start t3-ci-windows-base
```

The bootstrap installs the VirtIO serial driver/QEMU guest agent, PowerShell
7.6.7, Git for Windows 2.56.0.2 including Git Bash, Node 24.20.0, GitHub CLI
2.102.0, Python 3.14.5, Visual Studio 2022 C++ Build Tools and Windows SDK,
and Actions runner 2.338.0. GitHub release downloads have fixed SHA-256s;
Python/MSVC installers must have valid publisher signatures. Workflows
continue to install their selected Java/Rust/Vite+ versions.

Inspect `C:\ci-bootstrap\status.txt` through the guest agent. Only
`ready-for-validation` is a completed bootstrap; `failed` has an associated
non-secret installation error in `failure.txt`. Do not register this base.
Before approving it, verify native tool versions, compilation, HTTPS/DNS,
blocked host/private/metadata connections, no `.runner`/`.credentials`, and
no previously registered runner service. Remove setup media/password cache,
disable local administrator autologon, and shut down the base cleanly. The
evaluation image's license lifetime also belongs in its readiness record.
Copy `smoke.ps1` into `C:\ci-bootstrap\` and run it through the guest agent
with Windows PowerShell `-NoProfile -ExecutionPolicy Bypass -File
C:\ci-bootstrap\smoke.ps1`; it compiles and runs a Win32 program and returns
the non-secret tool, registration, network, and license checks.

## Cold image admission

Create `/home/devotek/t3-ci-windows/state` owned by root with mode `0700`
(the manager drops all capabilities). Its `base-approved.json`, mode `0600`,
must describe the actual verified cold
image, using these fields:

```json
{
  "base_uuid": "the verified libvirt domain UUID",
  "base_disk": "/var/lib/libvirt/images/t3-ci-windows-base.qcow2",
  "base_mtime": "exact libvirt storage volume mtime string",
  "base_xml_sha256": "SHA-256 of the exact inactive XMLDesc string",
  "verified_at": "UTC timestamp",
  "runner_version": "2.338.0"
}
```

Read UUID/domain XML with Python libvirt's `UUIDString()` and
`XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)`. Read mtime from the base volume's
`XMLDesc(0)` at `./target/timestamps/mtime`. Hash the domain XML string
without trimming or reformatting it. The manager rejects missing timestamps,
a changed disk, a changed device configuration, an active base, extra data
disks/NICs, filesystem mounts, and host device passthrough. It repeats this
admission check before every job VM. After maintaining the base, repeat cold
validation and replace the approval; an earlier approval cannot admit an
updated image.

## Dokploy manager

Build `Dockerfile` from this directory. Its Ubuntu 24.04 base is digest-pinned.
Publish or otherwise retain the resulting immutable image and set
`CI_WINDOWS_SUPERVISOR_IMAGE` to its digest in `docker-compose.dokploy.yml`.
For a local immutable `sha256:<image-id>` on this single host, also set
`pull_policy: never`; for a published registry image use `repository@sha256:<digest>`.
Use the protected existing App key path as
`CI_RUNNER_APP_PRIVATE_KEY_FILE`, and supply the existing GitHub App ID as
`GITHUB_APP_ID`. Never put key contents, PATs, installation tokens, or
registration tokens into Compose environment values or this repository.

Dokploy owns the persistent manager; do not also launch a shell/systemd
supervisor for this slot. The manager alone receives the libvirt control
socket, state directory, and App-key Docker secret. The job VMs receive none
of these. Its default slot is `t3-ci-win1`, with 8 vCPUs, 16 GiB RAM, and a
eight-hour maximum VM lifetime. Idle listeners recycle in less than one hour;
the manager checks only the presence of `Runner.Worker`, and stops idle
recycling once a job has started without extending the hard deadline. This
leaves at least seven hours for an assigned job. The slot's file lock prevents duplicate
manager processes. Additional slots require distinct reserved prefixes,
state directories, and dedicated gateways/subnets.

The manager privately creates a fresh, time-limited organization registration
token and sends it through the libvirt guest-agent API. `config.cmd` consumes
it inside the disposable VM. The App private key and installation access
token remain manager-only. `--ephemeral` limits the worker to one job.
Registration material and captured runner output are never printed to
manager logs.

Each VM has exactly one dedicated NAT network with the
`t3-ci-windows-egress` host filter. IPv6, host public addresses, private,
CGNAT, link-local/metadata, multicast, and reserved addresses are denied.
The provisioner also denies every discovered Docker/connected host subnet,
including the host's non-RFC1918 `172.32.0.0/16` Docker network. Public
`172` addresses outside those actual/private ranges remain available to CDNs.
Only internet HTTP(S) and gateway DNS are permitted. Each dedicated network
has one explicitly addressed `.2` guest with its exact IP supplied to the
anti-spoofing filter; no DHCP or address-learning race is required. The manager
sets the guest's address, route, and DNS through its independent guest-agent
channel before admission. All IPv4 allow/deny rules use the same iptables
layer; MAC-level IPv4 drops must not precede those rules.

## Cleanup and recovery

Success, failure, cancellation, VM/runner failure, stop, and the maximum
lifetime destroy the job VM, overlay disk, network, and leftover GitHub
registration. On manager restart, the janitor fences reserved slot resources
before inspecting base admission. It attempts every resource class even if
one teardown fails and refuses to create a new worker until cleanup succeeds.
The janitor matches only `<slot>-<12 lowercase hex digits>` and corresponding
`.qcow2` volumes; it never targets the base or shared `win2022` VM.

If the manager cannot start, inspect its non-secret error type and the cold
approval/tool/network checks. Missing GitHub App permission or API access
blocks new allocation after local orphan fencing. Recover only through the
Dokploy manager, preserve other organization pools, and verify slot resources
and registrations are removed after a cancelled/timed-out canary before
declaring the worker pool ready.
