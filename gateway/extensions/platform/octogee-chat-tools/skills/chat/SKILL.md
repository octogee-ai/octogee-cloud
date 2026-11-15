---
name: chat
description: Search and browse the workspace's team chat to ground answers in past conversation — recall a decision, catch up on a channel, or find context on a project or person.
metadata: { "openclaw": { "emoji": "💬" } }
user-invocable: false
---

# Chat — search & browse the team chat

You can read the team chat history to ground what you say in what's
actually been discussed. Two tools:

- **`octogee_chat_search`** — relevance search across the workspace ("did we ever
  decide X?", "what did Taylor say about the logo?").
- **`octogee_chat_history`** — read a channel in time order (catch up on what's new,
  or read around a post you found via search).

## When to use

- ✅ The user references something from before ("like we talked about," "the plan we
  made") — search for it instead of guessing.
- ✅ You've been pinged into a channel and need recent context → `octogee_chat_history`.
- ✅ Grounding a recommendation in a prior decision.
- ❌ Not for your own private memory — that's `memory_search`.

## How

```
octogee_chat_search({ "query": "logo direction", "scope": "all_visible", "limit": 10 })
octogee_chat_history({ "channel": "acme-general", "direction": "latest", "limit": 25 })
```

- **search** returns candidate posts (channel, author, time, snippet, permalink) in
  relevance order — read the snippets and decide what's relevant; they're
  *candidates, not answers*. Prefer a few targeted searches over one broad one.
- **history** pages with `cursor` + `direction: "before"`/`"after"`; use
  `direction: "unread"` to catch up since you last looked.

Both are scoped to this workspace. Your own past posts appear with
`self: true` — they're your words, not team evidence; never cite yourself as
if someone else said it. When you cite something, hand the user the permalink
so they can jump to it.
