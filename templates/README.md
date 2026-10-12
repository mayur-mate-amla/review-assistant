# Jira comment templates

The bot picks one of these files for every PR it comments on in Jira, so edit them to change the wording. Changes apply on the next post, no restart needed.

- `jira-approved.md` is used when the PR is approved.
- `jira-changes-requested.md` is used when changes are requested.

Format: `# Heading`, `* bullet`, `**bold**`, `[text](url)`, blank line = new paragraph. A line break inside a paragraph is kept.

Placeholders: `{{key}}` `{{area}}` `{{prNumber}}` `{{prTitle}}` `{{prUrl}}` `{{author}}` `{{risk}}` `{{checks}}` `{{findings}}` `{{tests}}` `{{reviewUrl}}` `{{reviewer}}` `{{date}}` `{{comments}}` and `{{issues}}`.

`{{issues}}` must be on a line of its own; it expands to one bullet per finding (must-fix first), or the open PR comments if the review has no findings.
`{{comments}}` is your own note when you wrote one, otherwise the AI's one-line reason.

If a file is missing, a one-line built-in comment is posted instead.
