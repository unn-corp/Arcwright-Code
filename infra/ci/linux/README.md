# T3 Code Linux runner image

Build from the repository root with `docker build -f infra/ci/linux/Dockerfile .`.
The base image digest, Ubuntu archive snapshot, and Android archives/checksums are
pinned. Publish the result under a new immutable digest before updating the dedicated
`t3-ci` pool; existing organization slots continue using their own image and labels.

Mothership also supports a local immutable Docker image ID with `pull_policy: never`.
The trusted supervisor uses the same image, keeping it referenced while job workers
are replaced. Copy the reviewed Linux source to `/home/devotek/t3-ci-build/infra/ci/linux`
on the host; its directory must be mode `0755`, and the manager/policy files at least
`0644`, because the manager drops DAC override capabilities. These files contain no
credentials. The App key remains in its existing protected host secret file.

Render each slot using its exact Dokploy-generated application name and reserved subnet:

```bash
runner_image=$(docker image inspect t3-ci-linux:20261014 --format '{{.Id}}')
python3 infra/ci/linux/render-compose.py \
  --project t3-ci-linux-1-xn1gvw --subnet 172.31.240.0/24 --image "$runner_image"
python3 infra/ci/linux/render-compose.py \
  --project t3-ci-linux-2-9rszi1 --subnet 172.31.241.0/24 --image "$runner_image"
```

Save the output as each service's raw Compose definition in Dokploy's **T3 Code CI**
project, then deploy through Dokploy. Keep the KVM supplementary group matched to
Mothership's device group (currently GID `994`). Do not start another shell or systemd
manager for the same slot.

The image supplies native T3 build dependencies, Java 17, Android command-line tools
19.0, API 36/build-tools 36.0.0, platform-tools 37.0.1, emulator 37.2.12, and the
API 36 Google APIs x86_64 system image. Google publishes SHA-1 checksums for SDK
packages in the [repository metadata](https://dl.google.com/android/repository/repository2-3.xml)
and [system-image metadata](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml).
Command-line tools additionally use the verified SHA-256 checksum. Package archives
are installed directly so an upstream SDK update cannot change an image rebuild.

Registration stays in the owner-controlled, short-lived registration container.
After registration, the job container must invoke `/usr/local/bin/t3-ci-start-runner`.
That command copies the immutable SDK into its fresh private workspace, initializes
cache and executable temporary directories, runs readiness checks, and starts the
existing GitHub Actions listener. It never registers a runner or reads an App key.

The owner-controlled Compose profile must retain:

- UID/GID `1001:121`, read-only root, dropped capabilities, `no-new-privileges`, and
  no host socket, App-key mount, sudo, or Docker supplementary group;
- one fresh `/_work` and runner-state volume per job, removed when the job exits;
- writable disposable `/home/runner` and tool-cache mounts; the existing 2 GiB home
  policy can remain because SDK, AVD, Gradle, Rust, Vite, and cache data live below
  `/_work/.t3-ci`;
- `/dev/kvm` passed through with permission for UID 1001 to read/write it. KVM group
  membership may be granted specifically for this device;
- `TMPDIR=/_work/_temp`, preserving executable temporary files without changing the
  host's bounded `noexec` `/tmp` policy;
- no Docker daemon, TLS client credentials, or Docker endpoint in the job container;
  finite CPU/memory/PID limits and destruction of the container, network, and every
  job volume after completion or cancellation.

The dedicated fork pool omits DinD. Enabled fork workflows and tests do not need
Docker; the retained AUR container job is guarded for the upstream repository. A
privileged DinD daemon on this host would expose host block devices to nested jobs
and does not satisfy this pool's data-isolation contract. Do not enable that job on
this pool or add a Docker endpoint without separately provisioning a suitable boundary.

The expanded SDK and emulator image exceed the 2 GiB home budget. Allocate disposable
workspace disk space for the SDK copy, Android AVDs, dependency stores, build outputs,
and Gradle caches. The startup refuses a reused `.t3-ci` directory.

`t3-ci-preflight --image` runs during the build and checks the real image user, tools,
native shared libraries, Java, and the SDK. `t3-ci-preflight --runtime` additionally
checks read-only root, empty effective capabilities, `no-new-privileges`, writable
job storage, and working emulator acceleration. Neither command builds T3 Code or
accesses registration credentials.

The Dokploy-owned `dokploy-supervisor.sh` creates an empty bridge, applies
`network-policy.py` through its trusted host-namespace helper, and only then starts
registration and the listener. It repeats that sequence for each fresh job, retires
idle listeners after one hour, and grants the first observed worker six hours plus
thirty minutes of grace within an eight-hour hard limit. Later processes cannot reset
that deadline. It removes its containers, volumes, and bridge
on completion, cancellation, timeout, or manager exit. The job never sees the manager's
host socket or registration secret.

The reserved slots use `172.31.240.0/24` and `172.31.241.0/24`, with bridges `t3ci-ln1`
and `t3ci-ln2`. The policy checks subnet ownership/collisions, rejects host addresses,
every other existing Docker subnet and host connected route, private/CGNAT/link-local/metadata destinations,
and source spoofing. Same-slot IPv4 traffic is allowed except the host gateway; public
TCP 80/443 and TCP/UDP DNS 53 are allowed. Other traffic is dropped. Host INPUT is
blocked for each owned bridge, and IPv6 is disabled on the host bridge with additional
interface-scoped IPv6 INPUT/FORWARD drops. Existing organization pools retain their
own bridges and firewall behavior.
