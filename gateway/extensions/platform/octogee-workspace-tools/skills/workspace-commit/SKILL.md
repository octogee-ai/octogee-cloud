---
name: workspace-commit
description: Save (commit + push) your workspace right now. Use for an immediate confirmed checkpoint after finishing a task, completing onboarding, or whenever the user asks to save.
metadata: { "openclaw": { "emoji": "💾" } }
---

# Workspace Commit — save your work now

Use **`workspace_commit`** for an immediate confirmed checkpoint after finishing a
task, completing onboarding, or when the user says "save that". No shell required.

Shared runtimes periodically checkpoint the coach workspace and canonical Gitea
project checkouts. Dedicated runtimes autosave their project checkouts; their
coach workspace still needs an explicit commit. Deferred GitHub checkouts are
not saved by Shared runtimes. Changes since the last successful save remain
local, and a failed push leaves them unsaved remotely. The shutdown flush has a
deadline and cannot guarantee that an outstanding save finishes before exit.

## How

```
workspace_commit({ "message": "optional summary of what changed" })
```

- **`message`** — optional. Defaults to `agent: workspace commit`. Keep it short and
  descriptive ("added the contact page", "finished onboarding setup").
- The workspace is taken from **your own identity** — you can only commit your own
  workspace; there's no slug to pass.

It returns:

```json
{ "committed": true, "pushed": true, "nothing_to_commit": false, "diverted_blobs": 0 }
```

- **`committed`** — whether there were changes to commit.
- **`pushed`** — whether the commit reached the remote.
- **`nothing_to_commit`** — `true` when the workspace was already clean (a clean no-op).
- **`diverted_blobs`** — how many binary files were moved into blob storage instead
  of being committed. Text is versioned in git; binaries are stored unversioned
  but backed up, and still show up in the Files view. You don't have to sort them
  yourself — just write the file where it belongs and commit.

## When to use it

- ✅ After completing a meaningful chunk of work, to checkpoint it.
- ✅ When the user says "save," "commit," or "back that up."
- ✅ At the end of onboarding, once you've filled in your identity, to publish it.
- ✅ Before relying on a remote snapshot, check that the save reports `pushed: true`.

If the remote rejects the push, the tool fails explicitly. Do not tell the
user the checkpoint is saved remotely, and do not start work that consumes a
remote snapshot until a later `workspace_commit` succeeds with `pushed: true`.
