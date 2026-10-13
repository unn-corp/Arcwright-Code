// Static DDL shared by the schema and its generated snapshot. Service inputs
// have the stricter Effect schemas; this check also rejects malformed raw SQL.
const pending = '"pending_mutation"';
const stringField = (field: string, maximum: number) =>
  `(jsonb_typeof(${pending}->'${field}') = 'string' AND length(${pending}->>'${field}') BETWEEN 1 AND ${maximum})`;
const shape = (fields: readonly string[]) =>
  `${pending} - ARRAY[${["action", "stepId", ...fields].map((field) => `'${field}'`).join(", ")}]::text[] = '{}'::jsonb`;
const action = (name: string, fields: readonly string[], predicates: readonly string[]) =>
  `(${pending}->>'action' = '${name}' AND ${shape(fields)} AND ${predicates.join(" AND ")})`;
const tunnelId = stringField("tunnelId", 191);
const tunnelName = stringField("tunnelName", 253);
const hostname = stringField("hostname", 253);
const dnsRecordId = stringField("dnsRecordId", 191);
const previousTunnelId = stringField("previousTunnelId", 191);
const origin = `(
  jsonb_typeof(${pending}->'origin') = 'object'
  AND (${pending}->'origin') - ARRAY['localHttpHost', 'localHttpPort']::text[] = '{}'::jsonb
  AND ${pending}->'origin'->>'localHttpHost' IN ('localhost', '127.0.0.1', '::1', '[::1]')
  AND jsonb_typeof(${pending}->'origin'->'localHttpPort') = 'number'
  AND (${pending}->'origin'->>'localHttpPort') ~ '^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$'
)`;

export const pendingMutationCheck = `${pending} IS NULL OR COALESCE((
  jsonb_typeof(${pending}) = 'object'
  AND octet_length(${pending}::text) <= 2048
  AND (${pending}->>'stepId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND (
    ${[
      action("create_tunnel", ["tunnelName"], [tunnelName]),
      action(
        "configure_tunnel",
        ["tunnelId", "tunnelName", "origin"],
        [tunnelId, tunnelName, origin],
      ),
      action("delete_tunnel", ["tunnelId", "tunnelName"], [tunnelId, tunnelName]),
      action("create_dns", ["hostname", "tunnelId"], [hostname, tunnelId]),
      action(
        "update_dns",
        ["dnsRecordId", "hostname", "previousTunnelId", "nextTunnelId"],
        [dnsRecordId, hostname, previousTunnelId, stringField("nextTunnelId", 191)],
      ),
      action(
        "delete_dns",
        ["dnsRecordId", "hostname", "previousTunnelId"],
        [dnsRecordId, hostname, previousTunnelId],
      ),
    ].join("\n    OR ")}
  )
), false)`;
