## Area: Database (repo znode10-multifront-db, SQL Server database project, Znode_Multifront_Database with schemas dbo, cso, cco)

Note: the repo has no written review guide, so these checks are the usual SQL Server release rules plus how this project is laid out (.sqlproj, tables, stored procedures, triggers, refactorlog).

**Compatibility and safety**
- The change must be safe to deploy while the previous API version is still running: no dropped or renamed columns, tables or procedure parameters that live code still uses; new columns nullable or with defaults; new procedure parameters optional.
- Destructive statements (`DROP`, `TRUNCATE`, `DELETE` without a tight `WHERE`, `ALTER COLUMN` that shrinks a type) need an explicit justification and a rollback path.
- Data migration scripts are idempotent (safe to run twice), batched for large tables, and wrapped in a transaction with error handling (`TRY...CATCH`, `XACT_ABORT ON`).

**Stored procedures and triggers**: `SET NOCOUNT ON`; parameterized (no string-built dynamic SQL from inputs, or `sp_executesql` with parameters); explicit column lists (no `SELECT *` into code); consistent naming (`Znode_...` prefix, PascalCase as in neighbours); no cursors or row-by-row loops over large sets; triggers must handle multi-row inserts and updates (use `inserted`/`deleted` as sets) and avoid recursion.

**Performance**: new queries use sargable predicates, sensible indexes for new filters and joins (and no duplicate indexes), no implicit conversions on join or filter columns, no scalar functions inside large selects.

**Integrity**: foreign keys and constraints match the code's assumptions (this is what stops orphan rows when a parent insert succeeds and a child insert fails); lengths and nullability agree with the API request models; collation and datatypes consistent with related columns.

**Project hygiene**: new objects are included in the `.sqlproj`; the refactorlog is updated when renaming; no environment-specific values, credentials or hard-coded ids; permissions (`GRANT`) follow neighbouring objects.

**Impact**: list the API procedures, tables and screens that depend on the changed objects, the deployment order relative to the API and admin PRs (DB normally ships first), and any backfill or index build that could lock a large table.

**Edge cases and performance to check on DB changes**: empty tables, NULLs in existing rows, very large tables (lock duration and log growth of a backfill), duplicate keys, rerunning the script, rollback, multi-row triggers, and objects used by several API versions. Performance: execution plans for new queries, index key order, included columns, parameter sniffing, scalar functions in selects, and index build time.

**Additional DB checks (standard review points)**
- Scripts are idempotent (`IF NOT EXISTS` / `CREATE OR ALTER`), start with `SET XACT_ABORT ON` where they change data, and use `THROW` (not `RAISERROR` for new code); names are schema-qualified (`dbo.`, `cso.`, `cco.`).
- Use `SCOPE_IDENTITY()` (or `OUTPUT`), never `@@IDENTITY`; no `NOLOCK` on data that must be correct; paging uses `ORDER BY` with a unique tiebreaker plus `OFFSET/FETCH`.
- Data types: `datetime2` for new dates, matching `nvarchar`/`varchar` across joins (avoids implicit conversion), sizes agree with the API models; audit columns (created/modified by and date) follow neighbouring tables.
- Constraints and indexes are named consistently; every new foreign key column used in joins has an index; no duplicate or overlapping index.
- Personal or sensitive data: no plain-text secrets, masked or encrypted as in neighbouring tables; seed data has no fixed environment-specific ids.
- Re-run safety and rollback: look for them in the script itself. Test cases and test results are NOT required for DB PRs, so never raise a finding about missing tests or test evidence.
