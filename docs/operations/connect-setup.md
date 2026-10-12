# Arcwright Connect setup

Deployment and client configuration for Arcwright Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

Choose `T3CODE_CONNECT_MODE=legacy|owned|cloudless` before building. An absent mode keeps
legacy behavior, including upstream example configuration and per-field process > `.env.local` >
`.env` precedence. Private Arcwright production Clerk, hosted app and relay delivery remain
uncommissioned; branding and a development identity do not provision production services.

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
provenance. Do not publish owned builds before that release/recovery work
and live commissioning are verified.

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
and pending statuses (8 KiB maximum). It contains no credentials, and causes no background retry.
The warning survives restart. To remove an old relay record later, deliberately select its original
profile, sign in with `t3 connect login`, and run `t3 connect unlink`; a compatible successful CLI
remote deletion clears only that matching reminder. A failed deletion or web local unlink can
leave a conservative reminder until that explicit cleanup. If the bounded reminder file is full or
unreadable, unlink refuses to discard the saved link rather than lose the cleanup reference.

These server guards do not authorize automatic cross-realm rollback to older source that lacks
binding checks. Historical release/recovery authority enforcement remains **NEXT Task4D**; native
installation/SDK credential authority handling and live owned-service commissioning are separate.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes the resulting relay URL back to the root `.env`.

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
Explicit cloudless mode clears managed inputs; absent-mode legacy builds retain existing behavior. Do not copy upstream example public configuration into an owned deployment by accident.
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

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
