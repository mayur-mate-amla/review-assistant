# PR Review Status: CHANGES REQUESTED ⚠️
**{{key}}** · Webstore PR [#{{prNumber}} {{prTitle}}]({{prUrl}}) · Author: {{author}} · Risk: {{risk}}

The Pull Request has been reviewed, and some changes are required before it can be approved.

**Issues Identified ({{blocking}}):**
{{issues}}

**Failed checks:** {{failedChecks}}
**Tests:** {{tests}}
**Cross-repo:** {{crossRepo}}

**Required Actions:**
* Fix every issue above and follow Next.js 15 standards: Server Components by default, awaited params, cookies and headers, and explicit fetch caching.
* Use the shared @znode packages (clients, types, base-components) instead of duplicating code, with no relative cross-package imports.
* Match the API contract in packages/clients and packages/types, and keep existing saved page data working.
* Add translations for every new string, handle loading, empty and error states, and keep the page accessible.
* Reply to or resolve every review comment.

**Review Outcome:** Approval is pending until every issue above is fixed. No open issue can be merged.
**Next Step:** Please update the PR, reply to the review comments, and re-request a review once the changes are completed.
**Reviewer Comments:** {{comments}} All findings with fix options are in the [GitHub review]({{reviewUrl}}).
Reviewed by {{reviewer}} on {{date}}.
