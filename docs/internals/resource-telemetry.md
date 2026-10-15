# Resource telemetry

Process counters come from a [standalone Rust monitor](../../native/resource-monitor/src/main.rs)
using `sysinfo`. Electron main supplies host power and Electron process metrics.
Keeping native collection outside Node isolates collector crashes and avoids a
Node/Electron addon ABI matrix. Desktop and CLI servers use the same child-process
protocol. A missing or failed collector leaves the server running.

## Collection cost

The native child owns sampling and bounded in-memory history. It samples on a timer
only while diagnostics has live subscribers. With none, the server sends a sample
interval of 0 and the child samples only on request, so an idle server never walks
the process table. History therefore covers only time with a live subscriber, plus
on-demand samples. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

History has independent bounds for age, snapshot count, process rows, and retained
bytes. A count limit alone cannot bound memory when command lines vary in size.
Large process trees therefore shorten the available history window. Linux task
enumeration is disabled because walking every `/proc/<pid>/task/<tid>` directory
makes sampling itself expensive.

Electron power updates travel over private inherited pipes, independent of the
renderer connection. Power events and slow heartbeats continue with diagnostics
closed; `app.getAppMetrics()` runs only on live demand. The receiver's stale deadline
must exceed the slowest configured heartbeat plus scheduling grace, or intentional
idle polling makes background policy oscillate between constrained and
unconstrained states. Headless servers leave unavailable power data unknown.

## Measurement traps

- Process identity includes start time because operating systems reuse PIDs.
  Electron and native start times have different precision, so merging allows a
  small tolerance. Process signaling rechecks the native identity with a fresh
  sample.
- Snapshot sequence numbers belong to a monitor generation. Comparing them across
  restarts would discard the new monitor's samples until its sequence caught up.
- Sampling can miss a process that starts and exits between samples. Cumulative
  counters still yield deltas for processes observed across samples.
- Windows process I/O includes more than disk traffic. Unix counters report storage
  I/O, which can differ from logical application reads and writes because of OS
  caching. Keep instrumented logical I/O separate from these counters.
- Group totals accumulate observed deltas since telemetry started. Per-process
  cumulative counters cover the operating system's lifetime for that process.
- Historical replay uses native samples without current Electron CPU or memory
  metrics. Merging the latest Electron values would overwrite the past.

A WSL backend needs a Linux monitor even though Electron runs on Windows. Windows
desktop packages currently supply only the Windows executable, so native process
telemetry for the WSL backend is unavailable. The inherited Electron power feed
still works.

## Agent start admission

[AgentStartAdmission](../../apps/server/src/resourceTelemetry/AgentStartAdmission.ts) uses the
shared five-second [HostResources](../../apps/server/src/resourceTelemetry/HostResources.ts)
cache, independent of the optional native process collector. Each environment holds new starts,
restarts, and restart continuations below 10% available RAM, with a reserve bounded between
512 MiB and 8 GiB. It resumes when available RAM reaches 125% of that reserve. Invalid memory
samples hold new starts until a valid sample recovers; CPU load does not impose a concurrency cap.
WSL reads Linux resources for its backend rather than Windows desktop process telemetry.

[EffectWorker](../../apps/server/src/orchestration-v2/EffectWorker.ts) applies admission before
claiming durable outbox rows. Held work stays pending without consuming attempts, leases, or
worker slots. Interrupts and cleanup remain eligible. Per-thread ordering remains intact until
cancellation removes a held start; restart continuations retain the existing recovery bypass.
Workers recheck held due work after five seconds rather than polling it every 25 ms, while outbox
notifications still wake them for new control work. Transition logs explain holds and resumption.

This is an admission safeguard, not a memory limit on running providers or their subprocesses.
Several starts can share a cached sample, and running jobs or unrelated applications can grow
after admission. Idle provider sessions retain their existing release policy. The isolated
[outbox/worker tests](../../apps/server/src/orchestration-v2/EffectOutbox.memory.test.ts) verify
20-start resumption and Stop under pressure; they do not certify sustained operation of 20 real
providers. Installed builds receive this behavior only after the changed server is packaged and
installed through the maintenance coordinator.
