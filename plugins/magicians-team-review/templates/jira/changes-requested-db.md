# PR Review Status: CHANGES REQUESTED ⚠️
**{{key}}** · DB PR [#{{prNumber}} {{prTitle}}]({{prUrl}}) · Author: {{author}} · Risk: {{risk}}

The Pull Request has been reviewed, and some changes are required before it can be approved.

**Issues Identified ({{blocking}}):**
{{issues}}

**Failed checks:** {{failedChecks}}
**Tests:** {{tests}}
**Cross-repo:** {{crossRepo}}

**Required Actions:**
* Fix every issue above and keep the change backward compatible with the API that is currently deployed.
* Make the scripts re-runnable (IF NOT EXISTS or CREATE OR ALTER) and wrap data changes in a transaction with SET XACT_ABORT ON and TRY...CATCH.
* Add the missing indexes and constraints, use set-based logic, and batch any large backfill.
* Name the API procedures and screens that depend on the changed objects, and confirm the deployment order with the API and Admin PRs.
* Reply to or resolve every review comment.

**Review Outcome:** Approval is pending until every issue above is fixed. No open issue can be merged.
**Next Step:** Please update the PR, reply to the review comments, and re-request a review once the changes are completed.
**Reviewer Comments:** {{comments}} All findings with fix options are in the [GitHub review]({{reviewUrl}}).
Reviewed by {{reviewer}} on {{date}}.
