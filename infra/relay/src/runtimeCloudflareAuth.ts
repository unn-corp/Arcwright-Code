import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/** Reuse the public Alchemy clients with separately provisioned runtime credentials. */
export const existingRuntimeCloudflareClients = (zoneId: Effect.Effect<string>) =>
  Effect.gen(function* () {
    const accountId = yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID");
    const tunnelToken = yield* Config.Redacted("RELAY_TUNNEL_API_TOKEN");
    const dnsToken = yield* Config.Redacted("RELAY_DNS_API_TOKEN");
    return {
      tunnels: Cloudflare.Tunnel.readWriteClient(
        Cloudflare.Tunnel.makeTunnelAuth({
          accountId: Effect.succeed(accountId),
          value: Effect.succeed(tunnelToken),
        }),
      ),
      dns: Cloudflare.DNS.dnsReadWriteClient(
        Cloudflare.DNS.makeDnsAuth({ value: Effect.succeed(dnsToken) }),
        zoneId,
      ),
    };
  });
