import * as Effect from "effect/Effect";
import { AccountInvalidSubject } from "./accountErrors.ts";

type Provenance = "session" | "authentication" | "deletion" | "bound";
const validUserId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 191 && /^user_[A-Za-z0-9]+$/.test(value);
const validInstance = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 191 &&
  /^[A-Za-z0-9._:-]+$/.test(value);
const validIssuer = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^https:\/\/([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(:[1-9][0-9]{0,4})?$/.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};
class Authority {
  readonly #configured = true;
  readonly issuer: string;
  readonly instanceId: string;
  private constructor(issuer: string, instanceId: string) {
    this.issuer = issuer;
    this.instanceId = instanceId;
    Object.freeze(this);
  }
  static fromValidatedConfiguration(input: {
    readonly issuer: string;
    readonly instanceId: string;
  }) {
    return validIssuer(input.issuer) && validInstance(input.instanceId)
      ? Effect.succeed(new Authority(input.issuer, input.instanceId))
      : Effect.fail(new AccountInvalidSubject({ reason: "invalid_identity" }));
  }
  static is(value: unknown): value is Authority {
    return (
      value instanceof Authority &&
      #configured in value &&
      value.#configured &&
      validIssuer(value.issuer) &&
      validInstance(value.instanceId)
    );
  }
}
class Subject<K extends Provenance> {
  readonly #provenance: K;
  readonly issuer: string;
  readonly instanceId: string;
  readonly userId: string;
  private constructor(issuer: string, instanceId: string, userId: string, kind: K) {
    this.issuer = issuer;
    this.instanceId = instanceId;
    this.userId = userId;
    this.#provenance = kind;
    Object.freeze(this);
  }
  static fromTrusted<K extends Provenance>(authority: Authority, userId: string, kind: K) {
    return Authority.is(authority) && validUserId(userId)
      ? Effect.succeed(new Subject(authority.issuer, authority.instanceId, userId, kind))
      : Effect.fail(new AccountInvalidSubject({ reason: "invalid_identity" }));
  }
  static validate(value: unknown, authority: Authority, kind?: Provenance) {
    if (
      !(value instanceof Subject) ||
      !(#provenance in value) ||
      (kind !== undefined && value.#provenance !== kind)
    )
      return Effect.fail(new AccountInvalidSubject({ reason: "verification_required" }));
    if (
      !Authority.is(authority) ||
      !validIssuer(value.issuer) ||
      !validInstance(value.instanceId) ||
      !validUserId(value.userId)
    )
      return Effect.fail(new AccountInvalidSubject({ reason: "invalid_identity" }));
    if (value.issuer !== authority.issuer || value.instanceId !== authority.instanceId)
      return Effect.fail(new AccountInvalidSubject({ reason: "authority_mismatch" }));
    return Effect.void;
  }
}
export type ConfiguredAccountAuthority = Authority;
export type OwnedSubject = Subject<Provenance>;
export type VerifiedOwnSessionSubject = Subject<"session">;
export type VerifiedDeletionSubject = Subject<"deletion">;
export type BoundOwnedSubject = Subject<"bound">;

/** Internal trust port: callers must FIRST verify real claims against server
 * configuration. These factories do no authentication and are not route input
 * decoders. D1 intentionally supplies no Config/auth/HTTP/runtime binding. */
export const makeVerifiedSubjectPort = (configuration: {
  readonly issuer: string;
  readonly instanceId: string;
}) =>
  Effect.map(Authority.fromValidatedConfiguration(configuration), (authority) => ({
    authority,
    fromAlreadyVerifiedSession: (userId: string) =>
      Subject.fromTrusted(authority, userId, "session"),
    fromAlreadyVerifiedAuthentication: (userId: string) =>
      Subject.fromTrusted(authority, userId, "authentication"),
    fromAlreadyVerifiedDeletion: (userId: string) =>
      Subject.fromTrusted(authority, userId, "deletion"),
  }));
export const validateOwnedSubject = Subject.validate;
export const validateOwnedUserId = (userId: string) =>
  validUserId(userId)
    ? Effect.void
    : Effect.fail(new AccountInvalidSubject({ reason: "invalid_identity" }));
/** Only the persisted matching binding may supply this internal capability. */
export const subjectFromMatchingBinding = (authority: ConfiguredAccountAuthority, userId: string) =>
  Subject.fromTrusted(authority, userId, "bound");
