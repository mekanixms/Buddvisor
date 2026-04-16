# Static data

- **predefined-prompts.json** — Predefined prompt snippets used by the "Insert Predefined Prompt" button in Configure Session (orchestrator and agent context). You can edit this file to add or change roles and prompts. Structure: `roles` (array of `{ id, label }`) and `prompts` (array of `{ id, label, roles, text }` where `roles` is an array of role ids).

- **prompting-recommendations.json** — Content for the "Prompting recommendations" panel (question mark button next to the chat input). Structure: `sections` (array of objects). Each section has `title` (required) and either `body` (paragraph text), optional `note` (muted line after body), or `items` (array of strings rendered as a bullet list).
