# Arcwright Connect setup

Deployment and client configuration for Arcwright Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Deploy the existing relay on owned infrastructure

Use `infra/relay/alchemy.run.ts`, the upstream relay stack. Account linking, connection
credentials, queues, notifications and managed endpoints use the existing implementation.
For an already provisioned PostgreSQL database, select its Hyperdrive binding instead of
provisioning PlanetScale. Keep these operator settings and all secrets in a private env file:

```dotenv
RELAY_DATABASE_PROVIDER=existing-hyperdrive
RELAY_HYPERDRIVE_ID=<existing Hyperdrive ID>
RELAY_API_ZONE_NAME=arcwright.space
RELAY_TUNNEL_ZONE_NAME=arcwright.space
RELAY_DOMAIN=relay.arcwright.space
RELAY_ZONE_OWNER_STAGE=devotek-pilot
RELAY_TRACING_ENABLED=false
RELAY_RUNTIME_TOKEN_MODE=existing
RELAY_TUNNEL_API_TOKEN=<existing account tunnel token>
RELAY_DNS_API_TOKEN=<existing zone DNS token>
APNS_ENABLED=false
```

Supply the Clerk, JWT audience, VAPID and Cloudflare deployment credentials documented below.
The existing-token mode uses Alchemy's public tunnel/DNS clients without minting new runtime
tokens. Tracing can stay disabled without an Axiom account; the client config output clears
old tracing endpoints and tokens. Omitting these overrides preserves the upstream defaults.

Set `ARCWRIGHT_CONNECT_RELAY_STATE_ROOT` to a private Alchemy state directory and
`T3CODE_RELAY_CLIENT_CONFIG_ENV` to a private output file. This keeps reversible secret state
and generated client configuration out of the checkout. Run the same stack and stage for
both commands:

```sh
alchemy plan --config "$REPO/infra/relay/alchemy.run.ts" --stage devotek-pilot --env-file "$CONNECT_PRIVATE_ROOT/deployment.env"
alchemy deploy --config "$REPO/infra/relay/alchemy.run.ts" --stage devotek-pilot --env-file "$CONNECT_PRIVATE_ROOT/deployment.env"
```

Apply the repository's PostgreSQL migrations using the existing migration role before the
Worker uses the external database; the runtime role remains DML-only. Build clients with the
existing owned public profile and retain the standalone APK's native sign-in and notification
adapters. Automatic account-deletion and route-enrollment extensions are separate features,
not prerequisites for this upstream-based setup.

## Public application configuration

Fork desktop releases select the checked-in `arcwright-connect.public.json` in the shared
desktop/server bundle build. This enables **Sign in to Arcwright Connect** in the Settings
sidebar and binds its browser authorization to `connect.arcwright.space`. The profile contains
only public client configuration. APK and recovery builds retain their separate selections.

Choose `T3CODE_CONNECT_MODE=legacy|owned|cloudless` before building. An absent mode keeps
legacy behavior, including upstream example configuration and per-field process > `.env.local` >
`.env` precedence. Private Arcwright managed access remains uncommissioned. The independent owned
hosted build can publish preparation pages before the relay and Google public signup are ready;
branding and a verified owner sign-in do not establish public managed access.

Owned mode requires one complete public profile:

```dotenv
T3CODE_CONNECT_MODE=owned
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
T3CODE_HOSTED_APP_URL=https://app.example.com
```

Without a profile file, the first source containing any Connect public field wins as a whole:
process variables, then `.env.local`, then `.env`. A partial higher source fails instead of mixing
with lower sources. Framework/native aliases are accepted when they agree exactly after trimming;
conflicting aliases fail. Use canonical names for operator input.

Alternatively, set `T3CODE_CONNECT_PROFILE_FILE` to a JSON file containing exactly the five
canonical public keys above, excluding the mode. Relative paths resolve from the repository root;
absolute paths support frozen profiles outside the checkout. The file must be a regular file no
larger than 16 KiB. Unknown keys, secrets and malformed files fail with value/path-free errors.
This explicit file wins incidental root env files. Process Connect fields alongside it must form a
complete, normalized-identical profile; partial or conflicting process overrides fail.

Owned profiles validate the Clerk publishable key, bounded identifiers, and HTTPS relay/hosted
origins written as `https://authority` with at most one root slash, without credentials, paths,
query or fragments. Malformed authority syntax and dot-segment paths fail before URL normalization.
Relay, hosted app and decoded Clerk issuer cannot use `t3.codes` or its subdomains. Generic Clerk development `*.accounts.dev` issuers are
supported. `CLERK_SECRET_KEY` belongs only in relay secrets, never in a public profile.

Cloudless mode explicitly clears managed canonical, web, Expo and native build inputs even when
ambient/root env configuration exists. Unrelated signing, toolchain, tracing and development
inputs retain their existing precedence. Expo omits Clerk setup and credential associations.
The server leaves saved Connect credentials and links dormant when the selected authority does
not match; direct pairing and application access remain available.

Web, bundled CLI, standalone APK and Expo use the selected profile. Owned CLI headless OAuth
uses its hosted origin; runtime overrides must supply all five fields atomically. An owned or
cloudless build rejects a contradictory runtime mode. Legacy builds can explicitly select owned
runtime mode with a complete validated profile. `VITE_CONNECT_HOSTED_APP_URL` carries the remote
authorization origin; `VITE_HOSTED_APP_URL` remains surface classification, including Android's
`https://appassets.androidplatform.net`. Set that surface origin explicitly only for a hosted web
deployment. Expo credential links follow the owned Clerk issuer.

Build metadata exposes a public-only normalized profile receipt and stable SHA-256 digest.
These hooks are not complete artifact provenance: owned/cloudless historical APK recovery is
blocked until the original artifact's profile is supplied and bound to its source and APK digest
through release/feed provenance. Recovery admission checks the historical checkout's own env/file
selection independently of ambient build overrides, so selecting legacy in today's environment
cannot mask an owned or cloudless predecessor. This refusal does not establish original-artifact
provenance. Native/server owned releases still require that release/recovery work and live
commissioning. The independent hosted preparation artifact does not commission those clients.

## Isolated database driver canary

[alchemy.driver-canary.run.ts](../../infra/relay/alchemy.driver-canary.run.ts) defines only
`ArcwrightConnectDriverCanary`, stage `devotek-driver-canary`, Worker
`arcwright-connect-driver-canary`. It binds existing Hyperdrive
`12d94be566e04becba00585b67444d28` in account `e0fa69f64063aa2670ad354549a34dd6`.
The required absolute `ARCWRIGHT_CONNECT_DRIVER_CANARY_CONFIG` JSON has exactly
`accountId`, `hyperdriveId`, `workerName`, `stage`, and `privateStateRoot`; it contains no secrets.
The distinct external state root ends in `driver-canary/alchemy`, is operator-owned mode 0700
with no symlink components, and must be the CLI cwd. The entry requires explicit account/stage,
`CI=true`, API token, and a privately injected canonical base64url probe secret of 32–64 random
bytes; it reads only the process secret provider. Never select the legacy relay entry.

The workers.dev endpoint is internet-routable and protected by `X-Arcwright-Canary-Key`.
Authenticated `GET /metadata` does not access the database; only authenticated `POST /probe`
runs fixed parameterized SELECTs and read-only transaction commit/rollback controls using the
installed Alchemy Drizzle/Postgres driver with `prepare:false`. Scope cleanup completes before
a success receipt; database failures produce fixed 503 responses. Read-only rollback control
does not establish durable DML rollback or application schema readiness.

The response deadline is 15 seconds, including stalled transaction controls or scope finalizers.
On deadline or request cancellation, interruption is requested and pending cleanup remains owned
by the event's native `waitUntil`; a 503 does not claim cleanup finished. Successful responses
await all finalization, and pools are scoped to each probe. Cloudflare limits pending HTTP
`waitUntil` work to [30 seconds after response or disconnect](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil),
then cancels unfinished work. Offline tests exercise the installed transaction coordinator's
stalled BEGIN, COMMIT, ROLLBACK and finalizer through the actual emitted Worker bridge.

Offline validation uses the public actual source provider and every unchanged emitted file in
installed workerd, with a private Unix HTTP socket and all outbound address classes denied.
Run the two `infra/relay/scripts/owned-connect-driver-canary*.test.ts` suites with one worker,
then `node infra/relay/node_modules/typescript/bin/tsc --noEmit -p infra/relay/tsconfig.driver-canary.json`.
[The offline builder](../../infra/relay/scripts/owned-connect-driver-canary-offline.ts) also accepts
`--output /absolute/private/fixture-directory`; the existing directory must be mode 0700 and no
cloud token or actual probe secret may be present. It retains all bundle files/maps and hashes.
Pinned date `2026-09-18` enables Node compatibility implicitly; Alchemy contributes
`new_module_registry` to runtime metadata, requiring workerd's local `--experimental` switch.
Its source provider materializes a Node flag for tooling only. Offline denial proves no
successful egress; separate accessor tests prove auth/metadata laziness.

This source slice is uncommissioned. After independent source reviews, separately review the
private plan for exactly this one Worker and its two bindings, then perform bounded real
Hyperdrive probes. Remove only the canary through its separate state. Offline checks do not
prove live Hyperdrive transport, repeated/concurrent connection cleanup, or relay readiness.

## Independent owned hosted web

[build-owned-connect-web.ts](../../scripts/build-owned-connect-web.ts) builds only the hosted web
package into a new external operator/evidence directory. It requires a clean committed checkout,
the complete five-field public profile, the reviewed public content digest, and separate content
configuration and content JSON files. The profile excludes credentials. The hosted build ignores
root and Vite dotenv files, passes an allowlist to the compiler, clears all unused tracing aliases,
sets its surface origin to the profile's hosted origin, leaves the release channel/local backend
pins/native classification empty, and disables source maps. Existing local, Electron, APK, Expo
and Vercel builds retain their own classifications and release controls.

```sh
nice -n 10 node scripts/build-owned-connect-web.ts \
  --profile /absolute/operator/connect-public-profile.json \
  --content-config /absolute/operator/hosted-public-content-config.json \
  --content /absolute/operator/hosted-public-content-draft.json \
  --reviewed-content-sha256 "$REVIEWED_CONTENT_SHA256" \
  --output-root /absolute/operator/new-hosted-build \
  --status preparing
```

The new root contains a frozen `assets/` upload tree and a separate `build-receipt.json` with exact
clean Git source, compiler-produced five-field/digest/surface proof, SHA-256 inventory, and the
installed Alchemy `Cloudflare.readAssets` manifest, hash, sizes, headers and redirects. Alchemy's
per-asset upload hashes include the extension and use 32 hex characters; they are distinct from
the inventory's ordinary SHA-256 hashes. The reader enforces 20,000 assets and 25 MiB per asset.
Branding, public pages, profile receipt and hosted headers precede manifest capture. Any subsequent
file change rejects deployment. Keep receipts, JSON drafts, operator notes, logs and state outside
the upload tree. A build receipt is not a deployment receipt.

`about.html` and `privacy.html` require neither JavaScript nor authentication. They provide public
contact at `theunnamed@theunnamed.dev`, navigation and the October 12, 2026 notice. Preparation copy
does not claim that public managed access or the manual Clerk/relay cleanup procedure is operational.
Ready copy requires an explicitly reviewed `status: "reviewed-ready"` content configuration and
`--status ready`; selecting that copy does not prove commissioning. The operator must first record
backend account-isolation, Google Production/public-signup and applicable native/hardware gates,
as well as a working deletion procedure. Do not publish draft JSON or maintainer notes.

[alchemy.web.run.ts](../../infra/relay/alchemy.web.run.ts) is an independent assets-only Worker stack:
`ArcwrightConnectWeb`, stage `devotek-pilot`, Worker `arcwright-connect-web`, domain
`connect.arcwright.space`. Its explicit `ARCWRIGHT_CONNECT_WEB_DEPLOY_CONFIG` JSON has exactly
`accountId`, `zoneId`, `hostname`, `stage`, `privateStateRoot`, `artifactReceipt` and `profileFile`.
Use account `e0fa69f64063aa2670ad354549a34dd6`, zone `71edc69babf1a57c2abca300c28c8c27`, the named
hostname/stage, and absolute external paths. `privateStateRoot` must be operator-owned mode 0700;
run the local Alchemy CLI **from that directory** with umask 077 so its own bootstrap logs also
remain private. Supply `CI=true` and `CLOUDFLARE_ACCOUNT_ID` equal to the configuration; the operator
injects the deployment token privately only at deployment time. No credentials enter this build.

```sh
# After operator account/zone/hostname checks and artifact review, from privateStateRoot:
umask 077
"$REPO/infra/relay/node_modules/.bin/alchemy" deploy \
  --config "$REPO/infra/relay/alchemy.web.run.ts" --stage devotek-pilot
```

The executable Stack wrapper retains Alchemy metadata and private context in compiled services;
LocalState writes live under `privateStateRoot/state/ArcwrightConnectWeb/devotek-pilot`. It refuses
unknown-resource adoption, uses no Cloudflare state-store Worker, and imports no relay/database/
tunnel/queue/Clerk-secret/Axiom graph. State's Redacted encoding is reversible: the operator must
maintain a separate encrypted private backup and test recovery. This entry neither deploys the
relay nor changes the existing website, marketing/Vercel publishing or upstream channels.

Cloudflare assets are served before SPA fallback, with `htmlHandling: none`; public `.html` URLs
remain stable and `/connect` PKCE fragments never pass through redirects. `/pair`, settings and
workspace routes use the SPA shell. Hosted-only headers revalidate shell, SW and public profile,
detach the overlapping global cache header before caching hashed assets immutably, and apply a
separate no-script policy to public pages. The shell
policy permits Clerk/challenge UI, current inline bootstraps, blob workers/WASM, and direct HTTPS/
WSS environments. Post-deployment verification must include real assets and public pages with
`Sec-Fetch-Mode: navigate`, valid/invalid CLI auth requests, and the unchanged loopback callback.
The shell explicitly allows `https://*.protect.clerk.com` in script and frame sources, and
`https://*.protect.clerk.com:*` in connection sources for Clerk's non-443 protection ports, as required
by [Clerk's CSP guidance](https://clerk.com/docs/guides/secure/best-practices/csp-headers).
Keep these narrow script/frame sources rather than adding a general HTTPS script source or
`unsafe-eval`. Verify Clerk protection bootstrap and sign-in in the served app after deployment;
keep both public pages under their detached `default-src 'none'; script-src 'none'` policy.
Welcome and Settings share the selected owned public profile's `/privacy.html` link. Owned copy
describes account/connection information and service availability; legacy and cloudless builds retain
their existing policy/copy. Desktop and APK bundles use the same web helper without treating their
local/native surface origin as the owned policy origin. These changes do not change telemetry
preferences or commission the relay.

Cloudflare injected its analytics beacon into actual hosted HTML even though the source has no
hosted OTLP destination. The operator disabled RUM specifically for `connect.arcwright.space`
using active Configuration Rule `fa2e08d90f77486e8c4662596419c5bc`: expression
`(http.host eq "connect.arcwright.space")`, action `set_config`, parameters `{ "disable_rum": true }`.
UI/readback and eight public response byte/cache/CSP checks passed. Preserve this hostname-scoped
operator setting when changing the hosted deployment; verify the served HTML bytes again after
changes. Do not broaden it to the apex or relax CSP to accommodate an injected beacon. Cloudflare
documents the supported [Disable Real User Monitoring setting](https://developers.cloudflare.com/rules/configuration-rules/settings/#disable-real-user-monitoring-rum).

Publishing preparation pages is independent of relay commissioning. Public account isolation,
Google Production, quota/abuse controls, deletion operations, private recovery and physical-device
delivery remain later gates; a hosted build or page deployment must not claim they passed.

## Owned database and tunnel operations

The Worker database stays lazy and scoped to each event. Transaction guards must resolve
the concrete client's transaction tag through `runtimePostgres.transactionActive`; reading
`transactionService` directly from a deferred Alchemy proxy does not identify the active
transaction. Concrete database fixtures use the same helper without a deferred wrapper.

Environment linking and unlinking have a 45-second relay deadline and a 50-second client
timeout for their database, tunnel and DNS operations. Public ingress admission and body
reading keep the ordinary nine-second deadline, as do other API requests. A first-time
tunnel can take longer than the ordinary request budget even when every step succeeds.

The owned PostgreSQL database and its tunnel are commissioned as the Dokploy-managed **Database and
Tunnel** application under **Mothership → Arcwright Connect → production**. Operate its compose
configuration, private environment and redeployments through Dokploy; retain the TLS roles and
private networks. Do not replace the managed application with an independently launched compose
stack. Keep resource identifiers, credentials, encrypted backups and recovery receipts outside the
repository and the hosted asset tree.

Keep persistent application files in `../files`, outside raw `code`; Dokploy recreates `code` on
redeploy. Keep private bind mounts read-only and preserve their existing owners and permissions.
Never store secrets in literal environment values, `mount.content`, or raw code. Preserve the external
PostgreSQL volume and private/egress networks, with no public database ports or Traefik domains.
Keep `freshVolumes: false`; normal redeployment must never use `down --volumes` or delete those
external volumes or networks.

Encrypted backup with isolated restore, TLS role checks, private-network checks and a normal managed
redeployment have been verified. Record and recheck those gates before changing that application;
use an isolated restore target rather than production for recovery trials. Database/tunnel
commissioning does not establish application migrations, public relay deployment, account isolation,
deletion operations or native delivery. The hosted publication remains **preparing** until the
remaining service gates are recorded.

The managed endpoint transport uses the pinned installed Cloudflare SDK with one HTTP attempt per
mutation invocation and bounded exact tunnel/DNS discovery. Coordinated B2b runtime writers now
retain one durable owner through provider work and atomic publication/revocation. SQL transactions
are short and hold no connection during network calls. Timeout does not establish that a mutation
had no effect: unknown mutation outcomes retain pending ownership and capacity. If final publication
commits but its acknowledgement is lost, authority and owner clearing may already be durable;
the allocation remains counted, no token or credential is returned, and no compensating deletion
runs. This lifecycle behavior is verified locally; service commissioning remains pending.
See the [lifecycle constraint](../internals/t3-connect.md)
before deploying runtime writers.

Managed endpoint admission now reserves capacity atomically per user before Cloudflare work.
The default is three held reservations; an exact user override may change it. Every allocation
counts, including incomplete provisioning, failed link or credential issuance, offline, unlinked
but retained, and released or cleanup-failed rows. Three offline or released reservations can block
a fourth until full teardown is confirmed and the allocation is removed. Reusing the same user's
existing environment allocation remains allowed at capacity and after a limit is lowered.
Do not delete an allocation merely to make room while its external resources may remain.

Public relay admission returns `429 relay_rate_limited` with `Retry-After: 60` for a temporary
denial. A limiter outage returns `503 relay_unavailable` and fails closed. The existing
`403 environment_link_limit_exceeded` still means the user's managed allocation quota is full.
Clients retain bearer, DPoP and installation credentials after 429. A rate-limit response does not
add automatic retries to mutation calls; existing managed recovery registration retries wait at
least `Retry-After` before trying again.

Admission follows the [per-operation policy](../../infra/relay/src/http/publicRelayPolicy.ts) for
verified users, environment keys and authenticated installations, with a mandatory canonical
trusted ingress IP/class gate. Namespaces **1101–1106** are reserved for this Worker. Before
commissioning, review account namespace collisions, verify the actual Cloudflare ingress and
`cf-connecting-ip` provenance through forwarding and Pseudo IPv4 settings, and check that the same
configured limiter bindings reach both the outer boundary and router. Binding tests do not
establish exact global budgets or replace atomic SQL quota reservations.

Atomic admission, coordinated lifecycle writers and public request limits are implemented in
source and verified locally. The upstream-based deployment adapter supports the existing owned
database and runtime credentials. Application migrations, the actual deployment and device
validation need their own operator receipts; source checks alone do not establish live readiness.

The durable lifecycle protocol is wired through the provider and all managed runtime callers.
Generic schema and migration defaults remain `legacy_unverified` with unresolved resource presence;
only admission explicitly inserts a known-fresh idle protocol row. Existing allocations are never
reset or classified automatically. A released marker, readiness or a null resource ID proves no
absence. Uncertain owners retain capacity indefinitely; timestamps never authorize owner stealing.
Legacy cutover needs operator classification and terminal provider proof, with no automatic reset
or classification tool. Source activation does not authorize production DDL or deployment.

## Changing the account service

New CLI OAuth exchanges record the actual issuer/token endpoint origin and public client ID.
Owned mode accepts a saved CLI credential only when this binding matches its complete effective
profile; old unbound CLI records need deliberate `t3 connect login` authorization. Background
startup never signs in, moves a refresh credential to a new endpoint, or removes a foreign record.
Legacy mode retains old unbound credential/link behavior, but checks a known authority binding.

Saved relay URL and effective issuer must match the selected owned relay origin. New owned links
also bind their public OAuth authority, so changing the Clerk realm or public client ID on the same
relay origin makes that link dormant. Changing only a hosted frontend URL or build version does
not require enrollment. Incompatible links remain saved and report “belongs to another account
service; unlink and reconnect”; cloudless links stay inactive. The connector, offline startup
fallback, remote recovery/shutdown deletion, relay proofs, activity publishing, held-webhook wake,
and advertised webhook origin all respect this admission. Existing nonce, replay, key and scope
checks still apply to admitted links.

Before changing profiles, explicitly select the original profile and use `t3 connect logout` while
that service is reachable if you want to revoke its environment record and remove its CLI login.
After selecting a new owned profile, `t3 connect unlink` (or **Unlink locally** in Connections)
stops the local connector and clears only Connect link state, intent and preferences, including
“hold webhooks while offline”. It leaves the old relay untouched and preserves the CLI authorization
unless you explicitly request logout. Provider credentials, direct connections and conversation data
are unaffected.

A local unlink writes a public pending-cleanup reminder beside `server-runtime.json` in
`connect-pending-remote-cleanup.json`: at most 16 old relay origins, environment IDs, timestamps
and pending/unresolved statuses (8 KiB maximum). It contains no credentials, and causes no background retry.
Known origins come only from the saved URL, issuer, or public link binding. A malformed or missing
URL does not prevent local stop, clearing, or explicit logout: when no safe origin is known, the
reminder stores a null origin with unresolved status and requires manual review. It never stores
a credential-bearing URL or substitutes the currently selected profile. The warning survives
restart. To remove an old relay record later, deliberately select its original
profile, sign in with `t3 connect login`, and run `t3 connect unlink`; a compatible successful CLI
remote deletion clears only that matching reminder. A successful compatible web deletion then
acknowledges the matching origin/environment through the paired server write grant; a failed
delete or acknowledgement retains the reminder. Unknown-origin references are never cleared
by a matching-current-profile guess. The Connections cleanup action remains visible in cloudless and partial-link states without
account sign-in; it still requires View relay and Manage relay permissions on the direct pairing.
Managed login/link creation remains unavailable in cloudless mode; CLI linking rejects before
relay-client acquisition, download prompts or authentication. A reminder cannot bypass a surviving
foreign link binding, even if the saved relay URL is missing. If the bounded reminder file is full,
corrupt or unreadable, unlink still disables the desired link and stops the local connector, but
retains link credentials and reports an unresolved cleanup error. Review the public reminder file
before retrying; logout also retains authorization on this failure. A local disable marker keeps
the retained link inactive across restart, including connectors, publishing and relay proofs.
Full explicit cleanup or a deliberate valid same-service relink clears that marker; background
reconciliation cannot reactivate it.
Server and CLI serialize each reminder read/modify/write through
`connect-pending-remote-cleanup.json.lock`. Acquisition waits at most a short bounded two-second
retry window, then reports failure; it never removes an old or unknown lock automatically. A crash
can leave this lock directory behind. Stop and verify all writers sharing that data directory before
manually reviewing and removing only the leftover lock directory, then retry explicit cleanup.
While the lock is unavailable, local disable and connector stop still occur, with credentials retained.

These server guards do not authorize automatic cross-realm rollback to older source that lacks
binding checks. Historical release/recovery authority enforcement remains **NEXT Task4D**; native
installation/SDK credential authority handling and live owned-service commissioning are separate.

For the existing upstream/legacy relay stack, copy `infra/relay/.env.example` to `infra/relay/.env` for
deployment settings. This does not configure the owned Dokploy database/tunnel or commission an owned
public relay. Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes the resulting relay URL back to the root `.env`.

Legacy browser PWA push uses the selected relay destination without account authentication.
Owned credentials and subscription IDs are origin-bound; global legacy records remain saved
and inactive in owned mode. A service or VAPID key change requires **Reset browser push**,
then a separate **Enable notifications** tap. Disable unsubscribes locally even in cloudless
mode; old remote cleanup can remain pending and does not send old credentials to a new relay.
Local service-worker previews remain available. The relay source derives anonymous shutdown
from the validated Clerk policy: `owned` disables config, registration, publishing and test
before side effects; malformed injected policy also fails closed. Installation-authorized removal
stays available only for cleanup. Publisher fanout, subscription transitions, queue production,
old signed anonymous jobs and direct Web Push sends enforce the same boundary. Omitted or
explicit `legacy` policy preserves existing anonymous clients; there is no owned enable override.
Authenticated registration atomically clears installation authority and obsolete transition
baselines when transferring an endpoint to an account. Authenticated account notifications remain
separate. Link `linkedAt` now records the current activation while the original creation date
is preserved; internal link and subscription incarnation UUIDs rotate on authority or push-target
replacement. Preferences-only registration retains the UUID and alert baseline. The ordered
`20261013030258_delivery_incarnations` database migration is tested only on a disposable fixture
and remains pending in production. These source and fixture checks do not deploy or
commission the owned relay. V2 activity/test jobs bind freshly selected subscription incarnations
and verified source provenance with WebCrypto HMAC. The source consumer now verifies HMAC/TTL
before policy or database access, then freshly validates exact ownership/incarnation/target on
every retry. Account activity requires current master/category preferences, the exact active
notification-enabled account/key/thread/link incarnation and matching current state/version/age;
copy and deep link are reconstructed, with names requiring queued and current permission.
Source phase age is checked with fresh time after the relevant authority read and before
claiming; exact expiry equality is allowed.
Explicit manual tests use fixed generic copy and `/` regardless of automated event preferences.
Owned mode rejects verified V1 and anonymous V2. Legacy V1 keeps historical queued-copy
compatibility. Legacy anonymous V2 requires current installation/environment/preferences and
signed kind/age, always generic copy and `/`; current source-key/state changes are not observable
through that legacy projection and can remain invisible until job TTL or phase age expires.
Denied jobs never claim or record attempts. 404/410 cleanup is transactional and conditional on
the observed subscription incarnation, preserving a replacement and its baselines. Database
observations admit each send without a network lock; later revocation can race an admitted
request, and every retry reauthorizes. These source fixtures count adapter requests, not browser
rendering or device arrival. Broader Worker assembly repair, production migration and owned
commissioning remain pending. Queue/test API acceptance proves enqueue only.
Native installation authority and historical recovery remain separate pending work.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the T3 CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Enable **Device authorization grant** on the application. Headless and SSH authorization use
   it, and Clerk only advertises the device endpoint once it is on. The feature is in beta and
   Clerk enables it per account on request.
5. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

For the owned instance, require PKCE for the authorization-code grant and select **opaque** OAuth
access-token format. The approved public client ID is `VS3HcN01wPJotPrs`; its `oa_` application
resource ID is not a client ID. Code and device grant checks proved refresh rotation and rejection
of both current and prior opaque access tokens after grant revocation. The JWT access-token
format remained verifiable after grant revocation, so strict owned relay admission rejects it.
No real token or account is needed for the source fixtures.

The owned relay stack must explicitly select this configuration alongside its private Clerk secret:

```dotenv
RELAY_CLERK_AUTH_MODE=owned
RELAY_CLERK_ISSUER=https://clerk.arcwright.space
RELAY_CLERK_CLI_CLIENT_ID=VS3HcN01wPJotPrs
CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsuYXJjd3JpZ2h0LnNwYWNlJA
CLERK_JWT_AUDIENCE=t3-code-relay
```

The publishable key must name the configured issuer. Issuers are exact HTTPS origins without paths,
query, fragments or credentials. Missing, partial and invalid owned policy fails closed; secrets
and Backend API destinations are never derived from token claims. Legacy deployments with no
policy fields retain the deliberate legacy default. Explicit blank policy settings fail before the
Worker layer is constructed; runtime admission checks the raw Worker bindings as well. Keep this
preflight ordering when adding an owned stack, and do not globally change other configuration defaults.
Empty or malformed successful OAuth verification responses produce controlled authentication denial.
This policy is implemented and fixture-tested;
the owned relay stack is not deployed by this change. Public relay commissioning, Google Production,
push isolation, quota/abuse, deletion and hardware checks remain separate gates.

Each owned opaque request makes one supported Backend API verification call. Admission requires
the approved client, a genuine user, the `openid`/`profile`/`email` scope subset, explicit false
revoked/expired flags and a non-null future integer expiration in Unix seconds through year 9999.
Outages, 404s and request deadlines fail closed. `offline_access` is refresh capability, not a
per-request relay permission. Ordinary newly signed-up users are accepted; environment ownership
still limits access to their own links. Native template JWTs retain SDK signature/time validation
and five-second skew, exact issuer and explicit audience checks. Their offline verification cannot
promise immediate revocation. The DPoP exchange remains session-only.

## JWT template

Create a Clerk JWT template named `t3-relay` with claims:

```json
{ "aud": "t3-code-relay" }
```

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` for clients and
`CLERK_JWT_AUDIENCE=t3-code-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
t3code-dev://app/
t3code://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `t3code-dev://app`; production uses `t3code://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

On Linux, `dev:desktop` registers `t3code-dev://` with a workspace launcher that
retains the running development app's profile and T3 home. Use that runner for
OAuth testing; launching the raw Electron binary can leave an older installed
app registered to receive the browser callback.

## Android native sign-in redirects

The upstream Expo client in `apps/mobile` and standalone fork APK use separate registrations.
Native foreground Arcwright Connect sign-in for the APK in `apps/android-pwa` is implemented, with
live commissioning pending. Its existing direct and Tailscale pairing remain available.

The upstream Expo Clerk SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the app's publishable key, add each supported package to **Native applications > Allowlist for mobile SSO redirect**:

| Variant     | Callback                                      |
| ----------- | --------------------------------------------- |
| Development | `clerk://com.t3tools.t3code.dev.callback`     |
| Preview     | `clerk://com.t3tools.t3code.preview.callback` |
| Production  | `clerk://com.t3tools.t3code.callback`         |

Preserve existing entries. These callbacks are separate from the `t3code-dev` / `t3code-preview` / `t3code` navigation schemes. A private development build using the production Clerk key still needs its development callback allowed by that instance's administrator; rebuilding the same package does not change the allowlist.

For the standalone package, enable Clerk Native API in the owned application, register Android
package `com.devotek.t3code.pwa` with the signing certificate SHA-256, enable Google if wanted, and
allow `com.devotek.t3code.pwa://auth/callback` for Account Portal hosted auth. Preserve the upstream
Expo entries above. This callback is distinct from Expo's Clerk SDK callback and desktop navigation.
See [Clerk hosted auth](https://clerk.com/docs/android/guides/account-portal/hosted-auth).

Build with the complete owned public profile described above. The Android build helper resolves
`loadRepoEnv` once, sends that profile to Vite and native BuildConfig, and supplies its public digest.
Explicit cloudless mode clears managed inputs; absent-mode legacy builds retain legacy public input
resolution, subject to native storage admission below. Do not copy upstream example public
configuration into an owned deployment by accident.

Keep the commissioned production Frontend API `https://clerk.arcwright.space` and publishable key
`pk_live_Y2xlcmsuYXJjd3JpZ2h0LnNwYWNlJA` stable before the first phone installation. The package and
signer registration remains `com.devotek.t3code.pwa` / SHA-256
`eb38a25cf25676b7418fee5105f66d9ff166bfd5546ba816288e5bd83b73d362`; preserve the callback above.
Changing the issuer after installation is not supported as an in-place SDK migration. Native startup
blocks an unknown nonempty SDK store or a mismatched app-owned issuer receipt before any SDK call.
Rebuilding, retrying, restarting or invoking public SDK reset does not establish a safe cross-issuer
recovery: reset retains SDK device identity, and delayed SDK responses can repopulate state. Keep the
matching issuer build for existing data and use direct pairing while the maintainer assesses recovery.
Do not clear app data, uninstall, copy SDK/refresh credentials or edit SDK storage to bypass this gate.
Legacy stores without a receipt receive the same conservative treatment when nonempty.
Managed notification references separately bind issuer, relay origin and JWT template. Unknown or
foreign references stay dormant and unchanged; only a new explicit registration from the current
native account can stamp the selected authority. Direct credentials and saved route choices survive.

The configured relay JWT template must carry the existing `aud: t3-code-relay` contract and a short
lifetime; the native bridge does not accept caller-selected templates.

Local compile/unit/lint checks do not commission delivery. Before declaring a configured APK ready,
verify live Google sign-in/callback, canceled and interrupted login, process-death stale callback,
established-session restoration, token renewal/revocation, logout offline and account replacement,
while retaining direct pairings, drafts and browser state. Native background DPoP/Connect renewal
is implemented; commission locked/background delivery, expiry renewal, process restart without a
WebView, account replacement, offline recovery and revocation against the owned relay. The
protocol tests use fake HTTP and do not establish live delivery. Production Clerk/domain/relay setup
and deployment require separate commissioning.

## Desktop passkeys

For a production macOS app with bundle ID `com.t3tools.t3code`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.com.t3tools.t3code`.
5. Configure signing as described in the [release runbook](./release.md#2-apple-signing--notarization-setup-macos).

Local signed builds additionally use:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/Arcwright Code (Alpha).app/Contents/MacOS/Arcwright Code (Alpha)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/Arcwright Code (Alpha).app"
codesign -d --entitlements :- "/Applications/Arcwright Code (Alpha).app"
```

## Sign-up policy

The owned public service is intended for anyone. Its relay policy checks the configured instance,
approved CLI client and token permissions without an operator-user allowlist. Provider accounts,
including Codex Personal, remain separate from Connect identity. Public-service commissioning is
still pending the gates above.

Separately operated restricted installations can use Clerk's email/domain allowlist or invitation-only
Restricted mode. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
