import {
  ForkMaintenanceActionInput,
  ForkMaintenanceError,
  ForkRecoveryRequest,
  ForkUpdatePolicyPatch,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { LocalPairingInput, serializeLocalPairingLink } from "../auth/localPairing.ts";
import { WorkAdmission, withWork, type MaintenanceWorkHeld } from "./WorkAdmission.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import { MaintenanceCoordinator } from "./MaintenanceCoordinator.ts";
import { MaintenanceService } from "./MaintenanceService.ts";
import {
  issueOperatorToken,
  OPERATOR_ROUTE_PREFIX,
  OPERATOR_TOKEN_HEADER,
  operatorTokenMatches,
  revokeOperatorToken,
} from "./operatorAuth.ts";

const decoders = {
  pairing: Schema.decodeUnknownEffect(LocalPairingInput),
  policy: Schema.decodeUnknownEffect(ForkUpdatePolicyPatch),
  action: Schema.decodeUnknownEffect(ForkMaintenanceActionInput),
  recover: Schema.decodeUnknownEffect(ForkRecoveryRequest),
};
const isMaintenanceError = Schema.is(ForkMaintenanceError);
const failure = (reason: string, status: number, blockers?: ForkMaintenanceError["blockers"]) =>
  HttpServerResponse.jsonUnsafe(
    { error: { reason, ...(blockers === undefined ? {} : { blockers }) } },
    { status },
  );

export const makeOperatorRoute = (
  token: string,
  maintenance: MaintenanceService["Service"],
  pairing?: (
    input: typeof LocalPairingInput.Type,
  ) => Effect.Effect<
    EnvironmentAuth.IssuedPairingLink,
    EnvironmentAuth.ServerAuthInternalError | MaintenanceWorkHeld
  >,
) =>
  HttpRouter.add(
    "POST",
    `${OPERATOR_ROUTE_PREFIX}:operation`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!operatorTokenMatches(token, request.headers[OPERATOR_TOKEN_HEADER]))
        return failure("The local operator credential is missing or wrong.", 401);
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) return failure("Bad request.", 400);
      const operation = url.value.pathname.slice(OPERATOR_ROUTE_PREFIX.length);
      const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => ({})));
      const run = (effect: Effect.Effect<ForkUpdateStatus, ForkMaintenanceError>) =>
        effect.pipe(
          Effect.map((status) => HttpServerResponse.jsonUnsafe(status)),
          Effect.catchTags({
            ForkMaintenanceError: (error) =>
              Effect.succeed(failure(error.reason, 409, error.blockers)),
          }),
        );
      const decodeFailure = Effect.succeed(
        failure("The request body is not valid for this operation.", 400),
      );
      switch (operation) {
        case "pairing":
          if (pairing === undefined) return failure("Local pairing is unavailable.", 404);
          return yield* decoders.pairing(body).pipe(
            Effect.flatMap(pairing),
            Effect.map((issued) =>
              HttpServerResponse.jsonUnsafe(serializeLocalPairingLink(issued)),
            ),
            Effect.catchTags({ SchemaError: () => decodeFailure }),
            Effect.catchTags({
              MaintenanceWorkHeld: () =>
                Effect.succeed(failure("Device maintenance is holding new work.", 409)),
            }),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
              Effect.succeed(failure("Could not create pairing link.", 500)),
            ),
          );
        case "status":
          return yield* run(maintenance.status);
        case "policy":
          return yield* decoders.policy(body).pipe(
            Effect.flatMap((patch) => run(maintenance.updatePolicy(patch))),
            Effect.catchTags({ SchemaError: () => decodeFailure }),
          );
        case "action":
          return yield* decoders.action(body).pipe(
            Effect.flatMap((input) => run(maintenance.runAction(input))),
            Effect.catchTags({ SchemaError: () => decodeFailure }),
          );
        case "recover":
          return yield* decoders.recover(body).pipe(
            Effect.flatMap((input) => run(maintenance.recover(input))),
            Effect.catchTags({ SchemaError: () => decodeFailure }),
          );
        default:
          return failure("Unknown maintenance operation.", 404);
      }
    }),
  );

/**
 * The CLI's door to the one controller. It exists so `t3 maintenance` cannot become a second,
 * weaker path: every operation lands in `MaintenanceService`, the same service the WebSocket RPC,
 * the desktop bridge and MCP use. Authority is the operator token file, not a session. Destructive
 * recovery additionally needs the exact recorded option, timestamps and acknowledgement in the body.
 */
export const operatorRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const coordinator = yield* MaintenanceCoordinator;
    if (coordinator.host.mode !== "active") return Layer.empty;
    // Resolved here, once, so the route carries no service requirement of its own.
    const maintenance = yield* MaintenanceService;
    const token = yield* Effect.promise(() => issueOperatorToken(config.baseDir));
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const admission = yield* WorkAdmission;
    const pairing = (input: typeof LocalPairingInput.Type) =>
      withWork(
        auth.createPairingLink({
          scopes: input.scopes,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.ttlMs === undefined ? {} : { ttl: Duration.millis(input.ttlMs) }),
        }),
      ).pipe(Effect.provideService(WorkAdmission, admission));
    return Layer.merge(
      makeOperatorRoute(token, maintenance, pairing),
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.promise(() => revokeOperatorToken(config.baseDir)).pipe(Effect.ignore),
        ),
      ),
    );
  }),
);

export { isMaintenanceError };
