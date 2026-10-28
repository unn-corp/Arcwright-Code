// @effect-diagnostics nodeBuiltinImport:off - Bootstrap validates operator configuration before any cloud resource can be constructed.
// @effect-diagnostics anyUnknownInErrorContext:off - Alchemy provider collections expose framework-owned requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import { readOwnedWebDeployConfig } from "./scripts/owned-connect-web-config.ts";
import {
  ownedPrivateAlchemyState,
  withOwnedPrivateAlchemyContext,
} from "./scripts/owned-connect-web-state.ts";
import {
  verifyOwnedWebArtifact,
  OWNED_WEB_ASSETS_OPTIONS,
} from "./scripts/owned-connect-web-artifact.ts";

const configFile = process.env.ARCWRIGHT_CONNECT_WEB_DEPLOY_CONFIG;
if (!configFile)
  throw new Error(
    "Require ARCWRIGHT_CONNECT_WEB_DEPLOY_CONFIG; no default deployment target exists.",
  );
const config = readOwnedWebDeployConfig(configFile);
if (NodePath.resolve(process.cwd()) !== config.privateStateRoot)
  throw new Error(
    "Run the owned hosted CLI from the configured private Alchemy storage root; CLI logs must also stay outside the checkout.",
  );
const { context: privateContext, state } = ownedPrivateAlchemyState(config.privateStateRoot);

const stack = Alchemy.Stack(
  "ArcwrightConnectWeb",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (
      stage !== config.stage ||
      process.env.CLOUDFLARE_ACCOUNT_ID !== config.accountId ||
      process.env.CI !== "true"
    )
      throw new Error(
        "Owned hosted deploy requires the explicit stage/account and CI=true environment credential path.",
      );
    const { directory: verifiedImmutableOutput, receipt } = yield* verifyOwnedWebArtifact(
      config.artifactReceipt,
      config.profile,
    ).pipe(Effect.orDie);
    if (
      config.privateStateRoot === verifiedImmutableOutput ||
      config.privateStateRoot.startsWith(`${verifiedImmutableOutput}/`)
    )
      throw new Error("Alchemy state cannot enter the upload tree.");
    const web = yield* Cloudflare.Worker("HostedWeb", {
      name: "arcwright-connect-web",
      workersDev: false,
      domain: { name: config.hostname, zoneId: config.zoneId },
      assets: { directory: verifiedImmutableOutput, ...OWNED_WEB_ASSETS_OPTIONS },
    });
    return { workerName: web.workerName, url: web.url, profileDigest: receipt.profileDigest };
  }),
);

// CLI loader needs the original Stack metadata. Override context on the executable
// effect, not just on a fixture, so compiled services and subsequent state capture
// both retain the private directory. Never enable unknown-resource adoption.
export default withOwnedPrivateAlchemyContext(stack, privateContext);
