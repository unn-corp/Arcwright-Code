# Arcwright Connect

The Connect display name is Arcwright Connect across the fork's clients and CLI. This does not
change the protocol, persisted identities, `t3 connect` command, `T3CODE_*` configuration keys,
JWT audience, or callback schemes. The public example still selects upstream T3 services;
private Arcwright Clerk and Cloudflare infrastructure is not commissioned. Native Connect
authentication is implemented for the standalone fork APK; live commissioning of the owned Clerk
instance and relay remains pending.

Arcwright Connect uses Clerk for cloud identity. The relay manages environment links,
credentials for reaching environments, and managed tunnel allocations. After
bootstrap, clients send application traffic through the environment's tunnel
hostname; the relay Worker does not proxy their HTTP or WebSocket sessions.
The one exception is automation webhooks: the relay forwards
`/v1/hooks/:environmentId/:hookId/:token` to the environment's tunnel so
senders get a stable URL. It keeps bodies and tokens out of its traces and
leaves token and signature verification to the environment
([forwarder](../../infra/relay/src/hooks/HookForwarder.ts)).

By default the forwarder stores nothing. An environment can opt in to having
the relay hold requests while it is offline
(`hold_webhooks_while_offline` on its link). Only then does the relay store the
raw request, including the hook token in the path, in a Durable Object for
that environment, with SQLite storage. The object pushes held requests back
through the tunnel from its alarm, oldest first, and backs off while the
environment stays away. When the tunnel reconnects, the environment asks the
relay to deliver right away. Requests are deleted once the environment
answers, after 24 hours, or when no user has the environment linked. The relay
still never checks the token; delivery goes through the same environment route.
Every forward carries `x-t3-relay-delivery-id`, so a request that reached the
environment before a timeout and is delivered again later runs once
([inbox object](../../infra/relay/src/hooks/HookInboxObject.ts)).

A Durable Object, not Postgres or Queues, because held requests are write-once,
read-once bodies of up to 1 MiB that need per-environment order, caps, and
retry timing. Queues cap messages at 128 KB and cannot hold one environment's
requests back while it is away.

The installed-PWA notification flow is intentionally independent of this
account system. See [PWA Web Push](./pwa-web-push.md) for the anonymous
per-installation path and the separate authenticated relay path.

Arcwright Connect uses one Clerk application for web, desktop, and mobile authentication. The relay verifies
two kinds of bearer credential: template JWTs generated from the `t3-relay` template with the shared
`t3-code-relay` audience, and Clerk OAuth tokens issued to the CLI. `verifyRelayClientBearerToken` in
`infra/relay/src/http/Api.ts` tries the template/session path first and falls back to OAuth
verification (`acceptsToken: "oauth_token"`), so the CLI's OAuth credential works without a JWT
template.
Clerk, deployment, and native authentication setup live in the
[Connect setup runbook](../operations/connect-setup.md).

## The relay is a trusted broker

An authenticated cloud user still needs an active environment link. The relay
asks that environment to mint a one-time bootstrap credential bound to the
client's DPoP key. The client exchanges it directly with the environment for an
[environment session](./environment-auth.md). The relay never receives that
session token, and possessing the bootstrap credential alone does not permit
redeeming it without the client's private key.

Both sides authenticate this exchange. The environment accepts only bounded,
replay-guarded relay proofs for its own identity, linked user, and requested
operation. Signed environment responses bind the result to the request nonce;
mint responses also bind the credential to the client proof key. The relay
verifies those bindings before returning a credential. This prevents a different
process behind the tunnel from impersonating the linked environment. The checks
meet in the
[environment link service](../../apps/server/src/cloud/CloudLink.ts) and
[relay connector](../../infra/relay/src/environments/EnvironmentConnector.ts).

The relay holds the signing authority for mint requests. DPoP protects an honest
exchange from credential reuse; it does not make a compromised relay signing
key harmless. Keep that trust assumption explicit when changing the protocol.

Managed tunnels expose only a validated loopback HTTP origin. Link proof checks
reject forwarded authority headers, and the relay resolves endpoints from its
own managed allocations rather than a caller-supplied URL. Health and mint
requests must not follow redirects. These restrictions keep endpoint discovery
from turning into arbitrary relay egress or exposing another service on the
environment host.

## A link outlives a connector process

CLI authorization, desired exposure, and a running connector have different
lifetimes. Linking can record intent while the server is stopped. Startup
reconciles that intent. CLI logout removes the stored cloud credential and
disables exposure without uninstalling the environment's background service.

Managed allocations belong to a user/environment pair. Provisioning checkpoints
external tunnel and DNS resources so retries can reconcile partial work. A
normal shutdown of a CLI-managed link releases its tunnel to avoid paying for
an idle resource, retaining the hostname reservation for the next startup.
It also retains the allocation record so the environment remains "offline"
rather than becoming "not authorized".

Two cases must retain the tunnel across shutdown. A link installed through a
client has no startup provisioning path and depends on its stored connector
token. An update handoff immediately starts a replacement server, and replacing
the tunnel would add routing propagation delay to every update. These exceptions
belong to [shutdown handling](../../apps/server/src/cloud/CloudLink.ts).

Release and unlink claim the allocation generation before deleting external
resources. A delayed cleanup must not delete a tunnel reused by a concurrent
restart or relink. Unlink commits authorization revocation before external
teardown, because a database failure must leave the active link usable. Failed
teardown retains enough state to retry. See the
[managed endpoint lifecycle](../../infra/relay/src/environments/ManagedEndpointProvider.ts).

## Idle tunnels are reclaimed and recovered

Cloudflare bills a tunnel whether or not a connector is attached, so a laptop
that sleeps with a linked environment leaves a paid tunnel behind. The relay's
five-minute maintenance job can reclaim those tunnels. `RELAY_TUNNEL_CLEANUP_MODE`
selects `off`, `dry-run`, or `enabled`, with `off` as the default. The mode is
read at deploy time, so changing it means a relay deploy, not a variable flip.
A candidate is a same-stage tunnel that Cloudflare reports down for at least
five minutes, or one that never connected and is at least an hour old. The
longer grace for never-connected tunnels covers a pairing still in progress.

Cleanup deletes only tunnels whose host has registered recovery. Allocations
without recovery registration belong to hosts that cannot replace a deleted
tunnel and are left alone. Allocations with no recorded tunnel ID, or a
different tunnel ID, are skipped because a provision may own them. A tunnel with
no allocation row at all is counted as `skippedOrphan` and never deleted: there
is no row to lock, so a relink that adopts it by name could race the delete.
Clear those by hand. Each sweep is bounded: at most ten list requests, 100 deletions, a
two-minute deadline, and an early stop on a Cloudflare rate limit. Each sweep
starts one budget further along the candidate list, so a block of deletes that
keep failing cannot starve the tunnels listed after them. See the
[reaper](../../infra/relay/src/environments/ManagedEndpointReaper.ts).

A host registers recovery at startup by sending its tunnel ID and loopback
origin with a short-lived signature from the environment key. Registration
touches Cloudflare only when the local host or port changed, and once per
existing allocation on the first registration after the upgrade because the
stored origin is empty. First registrations are jittered so an auto-update wave
does not hit the relay at once. The host stores a confirmed-origin marker with
the connector config, and a later boot starts the connector before registration
only when that marker matches the current config and port. If registration
cannot reach the relay for ten minutes, the host starts its stored config anyway
and keeps registering in the background until it can reconcile the origin.
If the connector exits, or `cloudflared` reports repeated tunnel
rejections, the host asks the relay for a replacement, at most once every two
minutes. The relay
provisions under the same allocation, so the hostname and DNS record survive
and clients keep their bindings. Every mutation on an allocation bumps its
`generation`, and deletion locks the row at the generation it claimed, so a
host that reconnects mid-sweep wins.

## OAuth traps

Interactive clients and the headless CLI use the same Clerk application but
different credentials. The relay accepts both session-template JWTs and CLI
OAuth tokens; requiring a JWT template for the CLI would reject valid logins.
The CLI is a public OAuth client using PKCE and stores no client secret.

Loopback CLI authorization starts on the hosted `/connect` page so sign-in
completes before entering Clerk's authorize endpoint. Sending a signed-out
browser straight to that endpoint loses the authorize parameters during the
sign-in redirect. The [shared flow](../../packages/shared/src/connectAuth.ts)
preserves PKCE and state for the loopback callback.

SSH and headless sessions use Clerk's OAuth device authorization grant because
the browser cannot ordinarily reach a listener on the remote machine. The CLI
polls Clerk's token endpoint directly while the user approves a short code on
Clerk's hosted device page; the hosted app plays no part and there is no
redirect URI or PKCE. The grant must be enabled on the CLI OAuth application
or the device endpoint returns an error before any prompt is shown.

## Standalone Android account boundary

The standalone APK uses the API-only Clerk Android SDK 1.1.11 through
[ClerkConnectAuthSdk.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ClerkConnectAuthSdk.kt).
[ArcwrightApplication.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ArcwrightApplication.kt)
initializes one process-scoped adapter before activities or background work. Clerk owns encrypted
Android Keystore session/device storage, established-session restoration, PKCE and token renewal.
The app never reads SDK private storage or copies web DPoP proof keys into Android.

Account Portal sign-in (including Google when enabled in the owned instance) opens the system
browser through `Clerk.auth.startHostedAuth`. The dedicated callback activity accepts only
`com.devotek.t3code.pwa://auth/callback`; Clerk validates the live attempt's state and PKCE.
Canceling, interrupting, or superseding a login releases it. A process killed during sign-in loses
SDK in-memory PKCE: the app consumes that exact callback as stale and asks the user to retry.
Persisted navigation markers contain no callback, authorization code, credential, or verifier.
An established session can restore after process death. A sign-out marker ensures a process
interrupted during logout clears the SDK account before exposing account state on its next launch.

[ConnectAuthBridge.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/ConnectAuthBridge.kt)
provides `t3ConnectAuth` only to main-frame messages from `https://appassets.androidplatform.net`.
It accepts bounded JSON/request IDs for status, subscribe, sign-in, relay token and sign-out.
Token requests use only the compiled JWT template; no arbitrary template, URL, fetch, device
credential, refresh credential, or proof key is exposed. Account generation, user and session
fences reject renewal results after logout or account replacement. Navigation clears listeners
and pending page requests. External phone-browser pages never receive this bridge.

[AndroidManagedAuthShell.tsx](../../apps/web/src/components/clerk/AndroidManagedAuthShell.tsx) is
selected before the browser Clerk shell. The app-owned auth context supplies native observable
state and the fenced token reader to the same relay account cleanup/activation used by web and
Electron. Only authoritative signed-out/account-change events remove relay environments and reset
the relay token cache; readiness and network failures retain the catalog. Logout clears all local
Clerk sessions even when remote logout fails, while directly paired connections, drafts, web-push
installation credentials and native-browser state remain independent.

Foreground Connect discovery and joining reuse the existing relay/DPoP protocol.
[NativeManagedEnvironmentSession.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NativeManagedEnvironmentSession.kt)
implements native background renewal with a distinct Android Keystore ES256 key. The origin-restricted
notification bridge receives only environment/account/session references and ordered registration
metadata. It never copies web DPoP tokens or keys. The worker exchanges the configured Clerk JWT at
`/v1/client/dpop-token`, obtains a proof-bound environment bootstrap, verifies the public descriptor,
and exchanges it at `/oauth/token` for only `orchestration:read`. Each socket gets a fresh DPoP-authenticated
websocket ticket and sends protocol 2 mobile/Android/relay metadata. Renewal uses a serialized in-memory
cache, bounded nonce retries, one rejected-token refresh and existing network backoff. Redirects,
invalid scope/type/expiry, mismatched origins/descriptors and authorization denial are rejected.

[NativeManagedNotifications.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NativeManagedNotifications.kt)
observes native auth without a WebView. Persisted references bind user/session identity; process-local
generations are captured again after SDK restoration. Loading/network failures retain registrations.
An authoritative logout/account change evicts managed references and fences HTTP, sockets and queued
alerts while retaining independent direct pairing, browser state and drafts. Ordered configuration
and registration writes allow managed/direct route changes while rejecting stale registrations.
Every accepted managed registration gets an opaque native revision. Rejection cleanup compares
that revision and the captured account/session/generation against native auth under the same lock
as registration writes. An old HTTP rejection therefore cannot erase a newer registration or its
state; deferred token eviction also matches the captured revision/fence. Cold restoration retains
the revision while capturing the restored SDK session's fresh process generation.
[NotificationFrameState.kt](../../apps/android-pwa/app/src/main/kotlin/com/devotek/t3code/pwa/NotificationFrameState.kt)
revalidates the selected mode/config/revision and managed account fence under that same lock at
watermark persistence and actual alert publication. Frames parsed before logout/removal/replacement
cannot recreate cleared watermarks. Direct connections use their selected credentials/revision,
independently of Clerk; unchanged direct selection retains its revision and legacy credential rows
remain readable. Returning from a managed route gives the direct selection a fresh native revision.
Presence-delayed alerts belong to the service connection that observed them. Closing any connection
for removal or replacement discards its pending alerts before the new selection can publish; ordinary
socket retry retains the same connection and its pending alerts, including independent direct pairing.
Registration replacement also clears its durable watermarks under the registration lock. The fresh
authoritative snapshot can then alert on an outstanding approval without replaying completed history
or transferring old queued content. Unchanged direct registration and socket retry retain watermarks;
removing a dormant direct registration clears them before a later re-enable.
Fake HTTP tests verify real ES256 signatures and the complete protocol; real-phone delivery and
owned-service commissioning remain pending.
