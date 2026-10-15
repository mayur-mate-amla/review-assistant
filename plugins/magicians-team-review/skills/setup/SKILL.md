---
name: setup
description: One-time setup for the Magicians team review plugin. Checks gh and the Atlassian connector, asks your role and options, and writes your settings file. Safe to run again.
disable-model-invocation: true
allowed-tools: Read Glob Write Bash(gh auth status) PowerShell(gh auth status) Bash(git remote *) PowerShell(git remote *) mcp__claude_ai_Atlassian__atlassianUserInfo mcp__claude_ai_Atlassian__lookupJiraAccountId mcp__claude_ai_Atlassian__getAccessibleAtlassianResources Bash(node *jira.mjs get *) PowerShell(node *jira.mjs get *) Bash(node *jira.mjs whoami) PowerShell(node *jira.mjs whoami) Bash(node *jira.mjs previous-assignee *) PowerShell(node *jira.mjs previous-assignee *)
---

Help the user set up the Magicians team review plugin. Be brief and ask one thing at a time. Never ask for a token or password: this plugin needs none.

1. **Check the tools.**
   - Run `gh auth status`. If `gh` is missing or not signed in, say: "Install GitHub CLI and run `gh auth login`. This lets the check read PRs." Continue anyway; the check still works on local changes.
   - Call the Atlassian connector `getAccessibleAtlassianResources`, then read any ticket key the user gives (or `atlassianUserInfo`). If it fails with 403 "The app is not installed on this instance", say: "Your Jira site admin has not allowed the Atlassian connector yet. Ask them to enable it, or set JIRA_EMAIL and JIRA_API_TOKEN in your own terminal (the plugin's script uses them and never stores them). Until then the check asks you to paste the ticket text." If it is simply not connected, say: "Connect Atlassian under Settings > Connectors in Claude." Continue either way.
2. **Role.** Ask: developer (check your own change before a PR) or reviewer (review other people's PRs and hand off). Default developer.
3. **Developer options** (skip for reviewers; explain each in one line and offer "no" as the default):
   - Reviewer to hand tickets to: ask for the reviewer's name or work email, then `lookupJiraAccountId` to confirm the person exists.
   - Post a short "pre-review check" comment on the PR when the check passes? (default no)
   - Add a short Jira comment when it passes? (default no)
   - Assign the ticket to the reviewer when it passes? (default no)
   - Move the ticket to a status such as "Code Review" when it passes? (default no; if yes, which status)
4. **Reviewer options** (skip for developers): the approver's name or email, and whether to post the GitHub review, post the Jira comment, reassign the ticket, and log time (default 10 minutes per PR, 0 to skip). Defaults are all on, each still asked before it happens.
5. **Write the settings** to `~/.claude/magicians-team-review.json` (create it, or update only the keys you changed if it exists). Use this shape and keep every key; fill unchanged ones from `${CLAUDE_PLUGIN_ROOT}/config.default.json`:
   `role`, `reviewer {name,email}`, `approver {name,email}`, `handoff {postDevCheckToPr, postJiraComment, assignToReviewer, transitionTo, confirm}`, `reviewerActions {postToGithub, postToJira, reassign, worklogMinutes}`, `blockSeverity`, `requireTestsAreas`, `repos`.
   Show the file content and ask before writing.
6. **Finish** with the next step: developers run `/magicians-team-review:pre-pr` on their branch or PR before assigning the ticket; reviewers run `/magicians-team-review:review TICKET-KEY`.
