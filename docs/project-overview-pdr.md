# Project Overview - NewsEngine

## Summary

NewsEngine is a plugin-based news delivery engine. It fetches articles from swappable sources, summarizes them with a configurable AI provider, and sends the result through swappable outputs. The current implementation is delivery-state driven: content generation, output sending, recovery, and maintenance replay all flow through a durable state machine.

## Product Goal

Deliver curated news digests that are:

- configurable by source, model, output, schedule, and audience
- safe to retry after crashes, timeouts, or partial provider mutation
- observable through the Worker, CLI, and dashboard
- deployable on Node.js or Cloudflare Workers without changing the core engine

## In Scope

| Area | Requirement |
|---|---|
| Source ingestion | RSS, HTML scrape, Hacker News, Reddit, Dev.to, GitHub trending, and generic JSON sources |
| AI summarization | Claude or OpenAI-compatible providers selected by config |
| Delivery | Telegram, X, Facebook, Threads, Slack, Discord, Email, webhook, and file outputs |
| Reliability | Durable claim/call/commit flow, sequential outputs, retry classification, operator recovery |
| Runtime | Node CLI, Cloudflare Worker, and dashboard runtime |
| Maintenance | Legacy compatibility replay and token-maintenance remain separate from authoritative delivery |

## Product Requirements

### Functional

1. A run must collect articles, apply middleware, summarize with AI, and send to configured outputs.
2. Output attempts must be processed sequentially and committed durably before the next output begins.
3. A crash, timeout, or ambiguous provider result must leave recoverable state instead of silently dropping work.
4. `run` bypasses cron gating; `cron` and `daemon` use the configured per-channel schedules.
5. `preview` is read-only and must not mutate delivery state.
6. Cloudflare manual trigger, force, canary, and recovery routes must use distinct trigger/operator authority.
7. Operator recovery must be idempotent and versioned.
8. Drip mode must preserve queue state across days and support bounded refill.
9. Aggregate status must expose a durable last-request pointer, source/queue/unresolved warnings, and paginated redacted records; exact request status must remain pollable after retention compaction.

### Non-Functional

1. Node.js runtime `>=18`; Node.js `>=22` for the pinned Workers development/test toolchain.
2. No build step for core execution.
3. Persistent delivery storage is required for any output-capable command.
4. Public status and recovery surfaces must redact secrets, private URLs, and generated content.
5. The dashboard must default to loopback and refuse unsafe non-loopback startup.
6. Rollout to production remains approval-gated; quiesce and bootstrap artifacts are staged, not casual deploy targets.
7. Cloudflare hot paths must use indexed physical domain tables; permanent replay/suppression tombstones must not retain article bodies, generated content, or raw operator reasons.

## Current Runtime Model

| Runtime | Storage | Notes |
|---|---|---|
| Node CLI | `LocalFileDeliveryStore` + cache | Single-process, owned local state file |
| Dashboard | `LocalFileDeliveryStore` + cache | Basic auth, same-origin mutation guard, no-store responses |
| Cloudflare Worker | `SQLiteDeliveryStore` inside one Durable Object | Per-channel coordinator, alarms, request idempotency |

The Cloudflare schema uses physical domain tables plus `news_schema_migrations`. Bulky terminal delivery data is removed after 30 days, ordinary request detail after 90 days, and operator audit data is minimized/compacted while unresolved records and permanent idempotency/safety tombstones remain.

## Acceptance Criteria

- AI generation is required for preview and delivery runs.
- Outputs are attempted sequentially with durable acknowledgement between calls.
- Source failures are diagnosed separately from genuine empty feeds.
- `MemoryCache` is not a production output-path store.
- `TRIGGER_SECRET` and `OPERATOR_SECRET` are distinct, and the dashboard uses its own trigger/operator credentials.
- Bootstrap mode allows health, status, queue, preview, and operator pause only.
- Quiesced mode performs no delivery mutation.
- Token maintenance is a separate switch and does not ride on delivery resume.
- X delivery topology requires the non-secret authenticated `X_DESTINATION_ID`.

## Rollout Policy

The repository includes a staged recovery path:

1. quiesce old writers without mutating production delivery state
2. introduce the SQLite Durable Object lifecycle baseline
3. validate a single-channel canary
4. resume only the approved channel

Rollback remains pause-first and state-preserving. The pre-lifecycle Worker is not treated as a casual rollback target once the Durable Object class lifecycle is in place.

## Success Metrics

- Tests pass offline without live provider calls
- Docs match the current runtime and config surface
- Recovery commands are exact, versioned, and idempotent
- Protected routes remain redacted and no-store
- Production rollout stays behind explicit approval gates
