# PR Review Status: CHANGES REQUESTED ⚠️
**{{key}}** · Admin PR [#{{prNumber}} {{prTitle}}]({{prUrl}}) · Author: {{author}} · Risk: {{risk}}

The Pull Request has been reviewed, and some changes are required before it can be approved.

**Issues Identified ({{blocking}}):**
{{issues}}

**Failed checks:** {{failedChecks}}
**Tests:** {{tests}}
**Cross-repo:** {{crossRepo}}

**Required Actions:**
* Fix every issue above and keep controllers thin (Controller to Agent to API client).
* Match the API contract: field names, required fields and status codes, and raise the missing API change if there is one.
* Use resource files for all text, encode all output, and protect state-changing requests with anti-forgery tokens and server-side permission checks.
* Scope CSS and JavaScript changes to the screen, rebuild the bundles if the source changed, and describe the UI change for QA in the PR.
* Reply to or resolve every review comment.

**Review Outcome:** Approval is pending until every issue above is fixed. No open issue can be merged.
**Next Step:** Please update the PR, reply to the review comments, and re-request a review once the changes are completed.
**Reviewer Comments:** {{comments}} All findings with fix options are in the [GitHub review]({{reviewUrl}}).
Reviewed by {{reviewer}} on {{date}}.
