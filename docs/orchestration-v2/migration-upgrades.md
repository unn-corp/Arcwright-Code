# Migration upgrades

The fork keeps its published migration IDs through 109. The upstream release
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

## Keeping upstream changes separate

`UpstreamMigrations.ts` records each upstream ID alongside its immutable deployed fork ID.
`ForkMigrations.ts` contains only fork-owned entries. `Migrations.ts` combines them in deployed
order; the reconciler derives its identity maps from the upstream registry. Moving source
ownership never changes the database ledger or skips a migration. Migration 109 is the fork's
message search index; it remains independent of upstream's current migration sequence.

After changing the upstream pin or either registry, run:

```bash
node scripts/check-upstream-database.ts
```

The pinned Git object must exist locally. The check uses Git objects and source files only;
it never opens a database. It checks all upstream migration bodies and V2 helpers, the 109
published identities in `historical-migration-identities.json`, and the exact source hashes
of intentional patches in `scripts/upstream-database-patches.json`. Update an exception only
after reviewing both versions and exercising the affected upgrade path. The fork documentation
workflow runs this gate on Windows and Linux, with a shallow fetch in its disposable checkout.
All three registries use the same static parser. Unrecognized entries or missing default imports
fail the check rather than silently reducing its coverage; migration modules are never executed.
Do not fetch a moving upstream branch or change the integrated pin just to make the check pass.

Migration 005 now matches upstream exactly; fork migration 47 still introduces the nullable
GitHub-account field. The project-event migration accepts upstream projects without that field
and preserves it when present. Final schema and historical migration identities are unchanged.
