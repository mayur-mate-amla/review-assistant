## Area: API (repo znode10-api-migration, C# / ASP.NET Core, Znode.Multifront)

Apply the team's own Code Review Guide. If you can read the repo, open docs/code-review/CODE_REVIEW_GUIDE.md first (the files on disk may be a different branch than the PR, so trust the diff for what the PR changes). If you cannot read it, the checks below are the summary. The checks that matter most:

**Controllers (V1)**
- Inherit `BaseController`; every action is `public virtual IActionResult`; verb attribute present; `[Produces(typeof(...))]` on every action.
- `[SwaggerResponse((int)HttpStatusCode.X, "...", typeof(ZnodeErrorDetail))]` for each non-200 code; 204 has NO type argument; never bare integers.
- Cache-first: the controller calls the cache class, never the service directly. Empty result returns `CreateNoContentResponse()`, data returns `CreateOKResponse<T>()`, create returns 201.
- Three catch blocks in order: `ZnodeAuthorizationException` (403), `ZnodeException`, `Exception` (500). Each logs via `_znodeLogging.LogMessage(ex, ZnodeLoggingEnum.Components.X.ToString(), TraceLevel.X)`. No empty or swallowed catches.
- `[TypeFilter(typeof(BindQueryFilter))]` on list/search actions, `[ValidateModel]` on POST/PUT with a body.
- V1 routes are registered in `App_Start/WebApiRoutes.cs` (route name kebab-case, URL segments PascalCase). V2 uses attribute routing under `Areas/V2` and must not change V1 signatures or routes.

**V2 / custom table**: `{Entity}ResponseV2`, `I{Entity}CacheV2`, full Swagger set (200, 204, 400, 403, 404, 500, 201 for create), `ZnodeException` branches on `ErrorCode`/`StatusCode` for 400 vs 404. Custom table uses `CustomTableConstant` and its own route file.

**Caching**: cache class inherits `BaseCache`; check cache first, call the service only when empty, never cache write operations or responses with `HasError`; `InsertIntoCache(routeUri, routeTemplate, response)`.

**Helpers**: `HelperUtility.IsNullOrEmpty/IsNotNull`, `HelperUtility.GetDate()` (not `DateTime.Now`), `APIConstant` defaults (not literal 1/10), `ErrorCodes.*` (not raw ints), `CachedKeys.*`, AutoMapper (no manual copying), `IZnodeLogging` (no Console/Debug).

**Security and data**: parameterized SQL only, no secrets or tokens in code or logs, `[WebstoreAttribute]` where the endpoint is webstore-scoped, file paths through `NetworkFileAgent`.

**Impact (always include in `risk` and `testing`)**: who calls the changed methods or models (services, controllers, caches, webstore/admin clients). Flag signature, return type or model property changes, DB or stored procedure dependencies, cache invalidation, and anything that would break an existing consumer. Mention if Stoplight/Swagger documentation needs to change.

For create/update endpoints also check: required and optional fields match the DB columns (nullability, lengths), the operation is atomic (parent and child inserts in one transaction), and failures return the right 4xx instead of 500.

**Tests are mandatory for API PRs.** The PR must (1) include test cases (automated tests in the changed files, or a written list of cases in the description or a comment) AND (2) show the results of running them in the GitHub PR description or a GitHub comment, with how many cases passed and how many failed (fill `tests.total`, `tests.passed`, `tests.failed`). Any failed case means `request_changes`. Cover the happy path, validation failures (400), not found (404), unauthorized (403), empty results (204) and the specific edge cases of the change. Missing cases or missing results make this a request for changes.

**Edge cases and performance to check on API changes**: empty or null collections, page size and index limits, duplicate creates and retries (idempotency), partial writes without a transaction, large filter or expand combinations, queries inside loops, missing indexes behind new filters, cache keys that ignore portal, locale or catalog, and responses whose size grows with data.

**Additional API checks (standard review points)**
- Authorization: every new or changed action has the right authentication and permission attributes; check for IDOR (an id from the request used without checking it belongs to the caller's portal/account) and over-posting (request models binding fields the caller should not set).
- Return DTO/response models, never EF or entity classes; no sensitive fields in responses.
- Async: `await` all the way (no `.Result`/`.Wait()`/`async void`), pass `CancellationToken` where the neighbours do, no `HttpClient` created per call, `IDisposable` released, DI lifetimes correct (no scoped service captured by a singleton).
- Data access: no queries or service calls inside loops, `AsNoTracking` for read-only queries, paging has an upper limit and a deterministic order, filters validated before use.
- Logging: no tokens, passwords or personal data in log messages; errors carry enough context (ids, route) to debug.
- Backward compatibility: existing V1 routes, parameters, response fields and status codes keep working; new request fields are optional.
- Swagger/Stoplight documentation matches the new behaviour; resource strings used for user-facing messages.
