## Area: Admin (repo znode10-admin-migration, C# ASP.NET MVC, Znode.Admin / Znode.Engine.Admin)

Note: the repo has no written review guide, so these checks come from its structure (Areas, Controllers, Views, wwwroot, Helper, Filters, EventObserver, MessageBroker/MessageConsumer, App_Code) and from the API repo's conventions that the admin calls into.

**Controllers and views**: controllers stay thin and call agents/clients, not the database. Check model validation (server-side, not only in the view), `[ValidateAntiForgeryToken]` on state-changing POSTs, authorization attributes on every new action, and that user input rendered in Razor views is encoded (no `Html.Raw` on user data). Errors must reach the user through the existing notification pattern rather than a blank page or a raw exception.

**API calls**: the admin consumes the Znode API. Verify request and response models still match the API PR (field names, required fields, status codes such as 201 versus 204). A change here usually pairs with an API change: flag it when the pair is missing or inconsistent.

**Front end**: JavaScript under `wwwroot` and views. Check for duplicated element ids, handlers bound twice, missing null checks on DOM lookups, hard-coded strings that should be resource strings, and layout or CSS changes that break other screens (shared stylesheets, `bundleconfig.json`, `compilerconfig.json`). For UI fixes (icon size, alignment, spacing) check that selectors are scoped and do not leak into unrelated pages, and that responsive behaviour is kept.

**Config and security**: no secrets, connection strings or tokens in `appsettings*.json` or `.env*` changes; no weakening of CSP, cookie or CORS settings; logging through the existing logger, not `Console`.

**Impact**: which admin screens and roles are affected; shared partials or helpers used by many pages; need for a cache clear or publish step; QA path through the admin portal.

**Edge cases and performance to check on admin changes**: users without the permission, empty grids, large grids without server-side paging, long names and special characters, double submit, browser back and refresh after a post, multiple stores or portals, and layout at small widths. Performance: N+1 calls to the API per grid row, synchronous calls on page load, large unminified scripts or images, repeated bundle changes.

**Additional admin checks (standard review points)**
- CSRF on AJAX posts (anti-forgery token sent in a header), not only on form posts; no state change on GET.
- XSS in JavaScript: `innerHTML`, jQuery `.html()`, `eval`, string-built HTML from server data or query strings; open redirects built from request parameters; file upload type and size validation.
- Permissions: a new menu item, button or action is hidden AND enforced server-side for the right roles; multi-portal data is filtered by the caller's portal.
- All user-facing strings come from resource files (`.resx`), including validation and notification messages.
- Model binding: no over-posting (bind only the fields the form shows); `ModelState` is checked before calling the API; API errors are surfaced, not swallowed.
- Minified or generated assets: if source scripts or styles change, the generated bundle is rebuilt and committed consistently (or the PR explains why not).
- Tests are NOT required for admin PRs: never raise a finding about missing tests or test results.
- UI changes: before/after screenshots are a nice-to-have (a `low` suggestion at most, never a blocker); keyboard and screen-reader basics (labels, focus order, contrast) are not made worse.
