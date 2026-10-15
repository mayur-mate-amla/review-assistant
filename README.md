# Magicians team review

Strict code review for Znode pull requests, in two forms:

- **`magicians-team-review` plugin for Claude Code**: developers check their own change before sending a PR, the reviewer reviews and hands off. Needs no API tokens.
- **Review Bot web app** (`server.mjs`, `index.html`, `team.mjs`): the reviewer's queue, comment posting, and the Team dashboard. Run by the reviewer only.

## For developers: check your change before you send a PR

### Install (once, about two minutes)
You need Claude Code (CLI or the desktop Code tab) signed in. Then in a terminal:

```bash
claude plugin marketplace add mayur-mate-amla/review-assistant
claude plugin install magicians-team-review@magicians-tools
```

Then, inside Claude Code in any of your repos:

```
/magicians-team-review:setup
```

The setup asks your role (choose developer), who your reviewer is, and what you want done automatically when the check passes. Everything is off by default.

**No GitHub token needed.** GitHub is read through the `gh` CLI you are already signed in with (`gh auth login`).

**Jira:** the plugin first uses the Atlassian connector in Claude (Settings > Connectors). On our Jira site (`amla.atlassian.net`) that connector currently answers 403 "The app is not installed on this instance", so until the Jira site admin allows it you have two choices:
- Set `JIRA_EMAIL` and `JIRA_API_TOKEN` in your own terminal session (create the token at id.atlassian.com > Security > API tokens). The plugin's small script `scripts/jira.mjs` uses them to read the ticket and, if you enabled it, comment, assign or move it. The plugin never stores the token.
- Or do nothing: the check asks you to paste the ticket text and skips the Jira steps.

If `gh` is missing, the check still works on your local changes.

### Every time
1. Finish your change (committed or not). Run, in the repo:

```
/magicians-team-review:pre-pr            # your current branch
/magicians-team-review:pre-pr Z10-12345  # a ticket key
/magicians-team-review:pre-pr <PR URL>   # an open PR
```

2. Read the **Must fix** list. Each item has the line, what breaks, and two to four ways to fix it. Say "fix all" (or pick numbers) and it edits your files. It never commits or pushes.
3. When it says **READY**, paste the printed "Pre-PR review" block into your PR description, then assign the ticket to your reviewer.

The check is strict on purpose: unresolved comments, unmet ticket requirements, breaking changes without a mitigation, architecture problems and, for API PRs, missing or failing tests all block.

### Optional settings
Run `/magicians-team-review:setup` again to change them. They live in `~/.claude/magicians-team-review.json` (or `.claude/magicians-team-review.json` inside a repo).

| Setting | Default | What it does when the check passes |
|---|---|---|
| `handoff.postDevCheckToPr` | off | Posts a short "pre-review check" comment on your PR |
| `handoff.postJiraComment` | off | Adds a short Jira comment with the result |
| `handoff.assignToReviewer` | off | Assigns the ticket to your reviewer |
| `handoff.transitionTo` | `Code Review` | Moves the ticket to this status (only used with the options above, blank to skip) |
| `reviewer` | empty | Your reviewer's name and email |
| `blockSeverity` | `medium` | Findings at this level or worse block |
| `requireTestsAreas` | `["api"]` | Areas where tests are mandatory |

Anything that posts, assigns or moves a ticket is shown to you first and needs your yes.

## For the reviewer

```
/magicians-team-review:review Z10-12345
```

It finds the ticket's PRs, reviews each with the right area rules, checks the cross-repo fit, and prints the verdict. Then it offers, one at a time and only with your yes: the GitHub review (from `templates/github`), the Jira comment (from `templates/jira`), a 10-minute work log per PR, and the reassignment (approved goes to the approver, changes requested goes back to the previous assignee). Choose `role: reviewer` and the approver in `/magicians-team-review:setup`.

The Review Bot web app does the same from a queue with a Team dashboard (`node server.mjs`, then open http://localhost:4300). It needs the reviewer's own Jira and GitHub tokens in `.env` (see `.env.example`).

## What is in this repo

```
.claude-plugin/marketplace.json            the marketplace "magicians-tools"
plugins/magicians-team-review/             the plugin (skills: pre-pr, review, setup)
  rubric/  templates/                      copies of agents/ and templates/ (do not edit here)
agents/                                    the review rules, shared by the bot and the plugin
templates/github, templates/jira           comment wording per area and verdict
scripts/sync-plugin.mjs                    copies agents/ and templates/ into the plugin
server.mjs index.html team.mjs             the Review Bot web app
```

### Releasing a change to the rules or templates
1. Edit `agents/` or `templates/`.
2. Run `node scripts/sync-plugin.mjs` (copies them into the plugin and writes the rules version).
3. Bump `version` in `plugins/magicians-team-review/.claude-plugin/plugin.json`, commit and push.
4. Developers update with `claude plugin marketplace update magicians-tools`.

### Access
The plugin is read from this GitHub repository. Give each developer read access (or keep the repo public) so `claude plugin marketplace add` can fetch it. Nothing in this repo contains secrets: `.env` and `data.json` are git-ignored.
