# Arcwright Connect setup

Deployment and client configuration for Arcwright Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

Arcwright Connect is disabled in a fresh clone. The repository-root example contains public
configuration for upstream T3 services at `relay.t3.codes` and `clerk.t3.codes`.
Copy it only when deliberately building against that upstream service:

```sh
cp .env.example .env
```

Private Arcwright Connect has not been commissioned. Its planned Clerk identity and Cloudflare
relay deployment require their own configuration and verification before use; the branding does
not provision those services. For your own deployment, set these values in the repository-root
`.env` or `.env.local`:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments.

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

Build with the owned application's public `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`
and HTTPS `T3CODE_RELAY_URL`. The Android build helper resolves root `.env`/`.env.local` once using
`loadRepoEnv`, sends those same values to Vite and native BuildConfig, and keeps unset configuration
cloudless. Do not copy upstream example public configuration into an owned deployment by accident.
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
