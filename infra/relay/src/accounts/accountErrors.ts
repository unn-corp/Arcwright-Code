import * as Schema from "effect/Schema";

// No identity, SQL parameters, credentials or upstream error payloads cross
// this boundary. The transport mappings and authentication are D2 work.
export class AccountDenied extends Schema.TaggedError<AccountDenied>()("AccountDenied", {}) {}
export class AccountAuthorityConflict extends Schema.TaggedError<AccountAuthorityConflict>()(
  "AccountAuthorityConflict",
  { reason: Schema.Literals(["missing_binding", "authority_conflict", "unbound_rows"]) },
) {}
export class AccountInvalidSubject extends Schema.TaggedError<AccountInvalidSubject>()(
  "AccountInvalidSubject",
  { reason: Schema.Literals(["invalid_identity", "authority_mismatch", "verification_required"]) },
) {}
export class AccountTransactionRequired extends Schema.TaggedError<AccountTransactionRequired>()(
  "AccountTransactionRequired",
  {
    reason: Schema.Literals([
      "transaction_required",
      "ambient_transaction",
      "read_committed_required",
    ]),
  },
) {}
export class AccountInvalidReceipt extends Schema.TaggedError<AccountInvalidReceipt>()(
  "AccountInvalidReceipt",
  { reason: Schema.Literals(["invalid_receipt", "receipt_conflict"]) },
) {}
export class AccountPersistenceError extends Schema.TaggedError<AccountPersistenceError>()(
  "AccountPersistenceError",
  {
    operation: Schema.Literals([
      "transaction",
      "lock",
      "authority",
      "deny",
      "write",
      "receipt",
      "intake",
    ]),
    retryable: Schema.Literal(true),
  },
) {}
export type AccountFenceError =
  | AccountDenied
  | AccountAuthorityConflict
  | AccountInvalidSubject
  | AccountTransactionRequired
  | AccountPersistenceError;
