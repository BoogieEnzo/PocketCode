# AI-Driven Interaction: Core Philosophy

_Started: 2026-03-04_

---

## The Shift

Current model: **human initiates → AI responds**. Every session, every action, every context switch is triggered by the user. The user is the scheduling layer.

Target model: **AI can initiate**. The user is a decision authority, not an operator. The gap between these two states is what this doc explores.

---

## Foundational Abstraction

The chat service is not a UI. It is a **communication channel between two agents** — one human, one AI. The human happens to be in control of when the channel is opened. But that's an implementation constraint, not a philosophical one.

The minimal extension needed to get AI-initiated interaction:

> The model can write a deferred message to itself. RemoteLab stores it and delivers it at the right moment.

This preserves the two-party dialogue primitive. The model is still "replying to a message." The message just happens to be one it wrote earlier. This is not a new abstraction — it's a scheduled trigger that feeds back into the same pipe.

---

## Mechanism: Deferred Triggers

**How it works:**

1. During any session, the model can emit a structured trigger:
   ```json
   { "type": "schedule", "at": "2026-03-05T09:00:00Z", "message": "Check build status and report." }
   ```
   or condition-based:
   ```json
   { "type": "on_complete", "session": "auth-refactor", "message": "Review what auth-refactor finished and continue." }
   ```

2. RemoteLab stores these triggers (a simple `~/.config/claude-web/triggers.json`).

3. A background process polls triggers and delivers them to the target session at the right time — which looks identical to a human sending a message.

4. The model responds. It can emit new triggers. The loop is closed.

**What this enables:**
- Long-running async tasks without human babysitting
- Cross-session coordination ("after X is done, do Y")
- Periodic check-ins ("every morning, summarize overnight progress")
- The model proactively surfacing blockers to the human without the human asking

---

## Session Organization

Sessions should be organized by **task context**, not by filesystem path. The folder concept leaks implementation details into the UX.

**New session schema:**
```js
{
  id, name, tool,
  created, lastActivity,
  workdir,           // optional — where to run commands, defaults to ~
  project,           // string tag ("remotelab", "video-editing", ...)
  status,            // "active" | "pending" | "blocked" | "archived"
  priority,          // "high" | "normal" | "low"
  tags,              // string[]
  summary,           // AI-generated one-liner, updated after each exchange
  blockedReason,     // if status=blocked: what's blocking
  nextAction         // what the human needs to decide
}
```

**The model manages this.** The model updates its own session's metadata after each exchange. The human never touches it unless overriding.

---

## The Control Surface

What the model needs to manage sessions:

| Tool | What it does |
|------|-------------|
| `update_session` | Set status, project, tags, blockedReason, nextAction for current session |
| `create_session` | Spawn a new task in a new session with given context |
| `list_sessions` | Read the full session board (all sessions, their status/summary) |
| `schedule_trigger` | Write a deferred or condition-based message |

Implementation path: expose these as HTTP endpoints in RemoteLab, document them in CLAUDE.md so the model knows they exist. No new protocol — Claude Code can call `curl` already.

---

## Human Role

The human is:
- A **decision authority** for things the model flags as `nextAction`
- An **interrupt handler** for `blocked` sessions
- An **observer** of the session board (sidebar)

The human is not:
- The session scheduler
- The progress tracker
- The one remembering what each session is doing

---

## Sidebar as the Control Panel

The sidebar is not a session list. It is a **live board** showing what the AI workforce is doing and what decisions are pending. Default sort: blocked (needs human) → active → pending → archived.

The model writes to this board. The human reads it.

---

## Implementation Phases

### Phase 1 — Remove folder dependency
- Make `workdir` optional
- Remove folder-grouped sidebar, flatten to list sorted by lastActivity
- Add `project` + `status` fields to session schema
- UI: filter chips by project, status tabs

### Phase 2 — AI session control
- Add `update_session`, `list_sessions`, `create_session` API endpoints
- Document them in CLAUDE.md so the model uses them automatically
- Model updates its own status/summary after each exchange

### Phase 3 — Deferred triggers
- `triggers.json` storage + background delivery loop
- `schedule_trigger` tool exposed to model
- Model can schedule its own follow-ups and cross-session handoffs

---

## Open Questions

1. **Trigger delivery**: how to handle a trigger for a session the user is actively viewing? Interrupt or queue?
2. **Trigger safety**: what stops the model from scheduling an infinite loop of self-messages? (probably: a simple max-depth counter per trigger chain)
3. **Session creation limits**: should the model be able to create unlimited sessions? Probably cap at N concurrent active sessions.
4. **Human override**: if the model marks a session as `archived`, can the human undo that? Yes — human always has authority over model's organizational decisions.
5. **Cross-session context**: when a trigger fires and says "continue from where X left off", how much context is passed? Probably the summary from `sidebar-state.json`, not the full history.
