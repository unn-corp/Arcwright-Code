import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

/* Resolve /resume from the composer selection, not the thread’s bound provider. Listing and resuming must use the same driver and account even after an earlier resume bound another session. */
export function resolveResumeSessionSource(input: {
  readonly selectedProvider: ProviderDriverKind;
  /** Instance backing the selection, when one resolved from provider statuses. */
  readonly selectedProviderInstanceId: ProviderInstanceId | null;
}): {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
} {
  return {
    driver: input.selectedProvider,
    // Not every selectable provider has a `providerInstances` entry (codex has
    // none on this machine), and the canonical default is the driver kind itself.
    providerInstanceId:
      input.selectedProviderInstanceId ?? defaultInstanceIdForDriver(input.selectedProvider),
  };
}
