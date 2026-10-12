# Comment templates

The bot builds every comment from a template, so you can change the wording without touching code. Changes apply on the next post, no restart needed.

```
templates/
  github/   comment posted on the GitHub PR
  jira/     comment posted on the Jira ticket
```

Each folder has the same files. The area file is used first, the generic file is the fallback:

| Verdict | Area files | Generic fallback |
|---|---|---|
| Approved | `approved-api.md`, `approved-admin.md`, `approved-db.md`, `approved-webstore.md` | `approved.md` |
| Changes requested | `changes-requested-api.md`, `-admin.md`, `-db.md`, `-webstore.md` | `changes-requested.md` |

If no file matches, a built-in comment is used.

## GitHub templates (markdown is posted as written)
Values: `{{key}}` `{{area}}` `{{prNumber}}` `{{prTitle}}` `{{prUrl}}` `{{reason}}` `{{summary}}` `{{checked}}` `{{risk}}` `{{checks}}` `{{tests}}` `{{date}}`.
Blocks (each disappears when empty): `{{mustFix}}` (every blocking finding with evidence and fix options), `{{failedChecks}}` (table of checks that did not pass), `{{apiTests}}`, `{{breaking}}`, `{{impact}}`, `{{optional}}` (collapsed low-priority notes) and `{{openPoints}}` (approved templates only).
The cross-PR notes, merge order and the "Reviewed at" footer are added after the template.

## Jira templates
Format: `# Heading`, `* bullet`, `**bold**`, `[text](url)`, blank line = new paragraph.
Values: `{{key}}` `{{area}}` `{{prNumber}}` `{{prTitle}}` `{{prUrl}}` `{{author}}` `{{risk}}` `{{checks}}` `{{findings}}` `{{blocking}}` `{{failedChecks}}` `{{tests}}` `{{crossRepo}}` `{{mergeOrder}}` `{{reviewUrl}}` `{{reviewer}}` `{{date}}` `{{comments}}`, and `{{issues}}` on a line of its own (one bullet per blocking finding, up to 6).
`{{comments}}` is your own note when you wrote one, otherwise the AI's one-line reason.
