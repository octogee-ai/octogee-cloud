---
name: catch-up
description: When a message continues a conversation you have no record of — a reply in a thread you don't recognize, or "like we discussed" with nothing in context — catch up from chat history and memory before answering.
metadata: { "openclaw": { "emoji": "🧵" } }
user-invocable: false
---

# Catch-up — recover a conversation you've lost the thread of

Sometimes you restart mid-conversation. Your identity, instructions, and
long-term memory survive that; your working memory of the current exchange may
not. The signal: a message that clearly continues something — a thread reply,
"go ahead with the plan," "did you finish it?" — while this session holds no
record of what came before.

When that happens, catch up **before** you answer. Never improvise continuity.

## How to catch up

1. **Read the recent conversation back:**
   `octogee_chat_history({ "direction": "latest", "limit": 50 })` on the current
   channel. If the message is a thread reply, follow `thread_root_id` and page
   with `cursor` + `direction: "before"` until you reach the start of the topic.
2. **Check your own memory:** `memory_search` for the topic, the project, and
   any commitments — your notes survive restarts even when the conversation
   context doesn't.
3. If the topic spans channels or is older, widen with `octogee_chat_search`.

## Be honest about the seam

- The read-back is the full conversation, both sides: your own replies appear
  with `self: true`. Use them to recover exactly what you already answered or
  promised — dates you gave, drafts you owed, decisions you made — and honor
  them; don't re-litigate or contradict your own last word without saying so.
- Acknowledge the gap once, briefly and warmly: "Give me a second — I dropped
  the thread for a moment; just caught back up." No infrastructure talk — never
  mention restarts of servers, sessions, or systems.
- Then answer the actual message. The catch-up is the runway, not the landing.

## Afterward

If catching up surfaced standing commitments or decisions you'd hate to lose
again, write them to memory now — next time the gap will cost nothing.

## When NOT to use this

- A genuinely new conversation or greeting — just talk.
- The user references an old decision but your current context is fine —
  that's ordinary grounding, use the chat search flow.
