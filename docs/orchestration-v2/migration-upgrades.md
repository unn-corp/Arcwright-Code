# Migration upgrades

The fork keeps its published migration IDs through 107. The upstream release
uses IDs 36–62 for a different sequence, so a database upgraded from upstream
cannot be migrated by comparing only the highest ID. On startup, the server
recognizes the pinned upstream ledger, matches those completed migrations by
name, and moves their ledger records to the fork IDs. It then applies the
fork-only migrations in the gaps before recording the already-present V2 and
webhook schema at fork IDs 95–98. Upstream MCP App model context, snapshot window indexes, and pull request review guides map to fork IDs 104–106. Reconciliation runs every missing fork migration through the highest remapped identity before restoring the ledger, including lossless storage and the schema fingerprint at 99–103. Upstream ThreadFailureLookupIndex (62) maps to fork 108; fork CompactHistoryBlocks remains 107. A previous fork at 103 only applies 104–108; its existing IDs and timestamps stay intact.

The same reconciler handles older fork preview databases that recorded V2 at
53 or 54. It preserves their V2 import state and applies the missing fork
migrations in one transaction. Unknown or conflicting histories fail before
they are changed. Keep this compatibility logic covered by
`reconcileV2PreviewMigration.test.ts` when adding migrations or changing the
upstream/fork manifest relationship.

Before invoking the migrator, the reconciled V2 ledger must contain every required name through its highest recorded ID. Missing or renamed entries fail closed, even if a later migration is already recorded. Matching schema and ledger fingerprints still skip migration execution on later opens.
