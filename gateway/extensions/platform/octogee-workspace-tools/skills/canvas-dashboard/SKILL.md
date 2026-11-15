---
name: canvas-dashboard
description: Compose and maintain the read-only Canvas Dashboard with status, stat, and link widgets.
metadata: { "openclaw": { "emoji": "📊" } }
---

# Canvas Dashboard

Use the Canvas Dashboard when a user asks for a concise, living project or
workspace home page. Its document is `.octogee/canvas.json` at the root of the
current workspace or project. Read the existing document before changing it.

## Document

```json
{
  "version": 1,
  "mode": "dashboard",
  "dashboard": {
    "title": "Launch room",
    "widgets": [
      {
        "id": "deploy",
        "kind": "status",
        "title": "Deploy",
        "value": "Healthy",
        "tone": "success",
        "detail": "Production · checked just now"
      },
      {
        "id": "signups",
        "kind": "stat",
        "title": "Signups",
        "value": "42",
        "detail": "This week"
      },
      {
        "id": "links",
        "kind": "links",
        "title": "Useful links",
        "links": [
          { "label": "Runbook", "href": "https://example.com/runbook" }
        ]
      }
    ]
  }
}
```

`mode` may be `markdown`, `app-preview`, `board`, or `dashboard`. Changing it
must preserve the complete `dashboard` object. Markdown stays in the Canvas
markdown file, previews stay managed by the preview service, and Board data
stays in the issue tracker; do not copy or erase any of those when switching
modes.

## Widget contract

- `status`: `id`, `kind`, `title`, `value`, `tone`; optional `detail`.
  `tone` is `neutral`, `success`, `warning`, or `danger`.
- `stat`: `id`, `kind`, `title`, `value`; optional `detail`.
- `links`: `id`, `kind`, `title`, and a `links` list of `{ "label", "href" }`.
  Every `href` is an absolute `https://` URL.

Keep ids stable when updating an existing widget. Use only these built-in widget
kinds. Do not put HTML, JavaScript, credentials, data URLs, or custom code in
the document: Canvas renders each widget in an opaque-origin sandbox with no
script permission and no ambient credentials.

## Finish

Write the complete JSON document, validate it is valid JSON, then use
`workspace_commit` when the user asked for a saved checkpoint. Tell the
user which status, stats, and links you added or refreshed.
