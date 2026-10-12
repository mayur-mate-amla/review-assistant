# PR Review Status: CHANGES REQUESTED ⚠️
**{{key}}** · API PR [#{{prNumber}} {{prTitle}}]({{prUrl}}) · Author: {{author}} · Risk: {{risk}}

The Pull Request has been reviewed, and some changes are required before it can be approved.

**Issues Identified ({{blocking}}):**
{{issues}}

**Failed checks:** {{failedChecks}}
**Tests:** {{tests}}
**Cross-repo:** {{crossRepo}}

**Required Actions:**
* Fix every issue above and keep V1 routes, parameters and response fields backward compatible.
* Add or update unit test cases for every changed endpoint and service method (success, 400, 404, 403, 204 and edge cases).
* Run all tests, make sure every case passes, and add the results (passed and failed counts) to the PR description.
* Update Swagger and make the matching Admin and Webstore changes where the contract changed.
* Reply to or resolve every review comment.

**Review Outcome:** Approval is pending until every issue above is fixed. No open issue can be merged.
**Next Step:** Please update the PR, reply to the review comments, and re-request a review once the changes are completed.
**Reviewer Comments:** {{comments}} All findings with fix options are in the [GitHub review]({{reviewUrl}}).
Reviewed by {{reviewer}} on {{date}}.
