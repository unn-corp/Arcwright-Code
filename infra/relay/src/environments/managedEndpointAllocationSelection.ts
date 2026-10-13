import { relayManagedEndpointAllocations } from "../persistence/schema.ts";

export const allocationSelection = {
  userId: relayManagedEndpointAllocations.userId,
  environmentId: relayManagedEndpointAllocations.environmentId,
  hostname: relayManagedEndpointAllocations.hostname,
  tunnelId: relayManagedEndpointAllocations.tunnelId,
  tunnelName: relayManagedEndpointAllocations.tunnelName,
  dnsRecordId: relayManagedEndpointAllocations.dnsRecordId,
  readyAt: relayManagedEndpointAllocations.readyAt,
  origin: relayManagedEndpointAllocations.origin,
  updatedAt: relayManagedEndpointAllocations.updatedAt,
  generation: relayManagedEndpointAllocations.generation,
  tunnelReleasedAt: relayManagedEndpointAllocations.tunnelReleasedAt,
};
