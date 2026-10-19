import { RelayProtectedError } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { isHttpClientError } from "effect/http/HttpClientError";

/**
 * `unavailable` means it may succeed on retry; the relay refused the other
 * kinds. The description is safe to show: it carries the relay's own
 * explanation and trace ID, never request details.
 */
export class RelayRequestError extends Schema.TaggedError<RelayRequestError>()(
  "RelayRequestError",
  {
    rejection: Schema.Literals(["unauthorized", "forbidden", "rejected", "unavailable"]),
    description: Schema.String,
    retryAfterSeconds: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600)),
    ),
  },
) {
  override get message(): string {
    return this.description;
  }
}

const isRelayRequestError = Schema.is(RelayRequestError);

export function relayRequestError(cause: unknown): RelayRequestError {
  return isRelayRequestError(cause)
    ? cause
    : new RelayRequestError({
        rejection: "unavailable",
        description: `Could not complete the Arcwright Connect relay request. ${isHttpClientError(cause) ? `The relay request failed (${cause.reason._tag}).` : "The relay returned an unexpected response."} Check this machine's network connection and relay availability, then retry.`,
      });
}

export const shouldRetryRelayRequest = (error: unknown): boolean =>
  !isRelayRequestError(error) || error.rejection === "unavailable";

function recoveryHint(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayRateLimitExceededError":
      return `Too many relay requests. Try again in ${error.retryAfterSeconds} seconds.`;
    case "RelayEnvironmentLinkLimitExceededError":
      return "Unlink an unused environment in Arcwright Connect, then restart Arcwright Code on this machine.";
    case "RelayAuthInvalidError":
      return "Run `t3 connect login` to check this machine's authorization. If the stored credential was revoked, sign out with `t3 connect logout`, then run `t3 connect` again. Restart Arcwright Code after signing in.";
    case "RelayEnvironmentLinkProofExpiredError":
    case "RelayEnvironmentLinkProofInvalidError":
      return "Check this machine's date and time, update Arcwright Code, then restart it.";
    default:
      return "Retry when the relay is available. If this continues, include the trace ID when reporting it.";
  }
}

export const filterRelayResponse = Effect.fn("cloud.filter_relay_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const decoded = yield* HttpClientResponse.schemaBodyJson(RelayProtectedError)(response).pipe(
    Effect.option,
  );
  const ray = response.headers["cf-ray"];
  const requestId = ray && /^[a-zA-Z0-9-]{1,128}$/.test(ray) ? ` Cloudflare Ray ID: ${ray}.` : "";
  const description = Option.isSome(decoded)
    ? `Arcwright Connect: ${decoded.value.message}. ${recoveryHint(decoded.value)} Trace ID: ${decoded.value.traceId}.`
    : `Arcwright Connect relay returned HTTP ${response.status} without a recognized error response. Check relay access and any proxy or firewall restrictions, then restart Arcwright Code.${requestId}`;

  // The only 401 that clears itself: a proof signed with a skewed clock (a host
  // that booted before NTP) expires on arrival, and the next attempt signs a new
  // one. It is recognized only from a schema-decoded relay body. Every other
  // 401, including a revoked bearer or an undecodable body, stays permanent.
  if (
    response.status === 401 &&
    Option.isSome(decoded) &&
    decoded.value._tag === "RelayEnvironmentLinkProofExpiredError"
  ) {
    return yield* new RelayRequestError({ rejection: "unavailable", description });
  }
  if (response.status === 401) {
    return yield* new RelayRequestError({ rejection: "unauthorized", description });
  }
  if (response.status === 403) {
    return yield* new RelayRequestError({ rejection: "forbidden", description });
  }
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 408 &&
    response.status !== 429
  ) {
    return yield* new RelayRequestError({ rejection: "rejected", description });
  }
  const retryHeader = response.headers["retry-after"];
  const headerSeconds =
    retryHeader && /^\d{1,4}$/.test(retryHeader) ? Number(retryHeader) : undefined;
  const retryAfterSeconds =
    response.status === 429
      ? Math.max(
          60,
          Option.isSome(decoded) && decoded.value._tag === "RelayRateLimitExceededError"
            ? decoded.value.retryAfterSeconds
            : 0,
          headerSeconds !== undefined && headerSeconds > 0 && headerSeconds <= 3600
            ? headerSeconds
            : 0,
        )
      : undefined;
  return yield* new RelayRequestError({
    rejection: "unavailable",
    description,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
});
