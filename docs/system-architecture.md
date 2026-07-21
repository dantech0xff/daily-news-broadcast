# System Architecture

## Overview

NewsEngine is a composable delivery engine. Sources, AI providers, outputs, and caches are plugins. Delivery correctness now depends on a durable state machine and a durable store, not on best-effort cache writes.

## Topology

```text
Node CLI / Dashboard / Cloudflare Worker
  -> channel definitions
  -> NewsEngine
  -> DeliveryStateMachine
  -> delivery store
  -> output plugins
```

The runtime entry points are:

- `src/adapters/node.js` for manual runs, cron, preview, and local recovery controls
- `src/adapters/cloudflare.js` for Worker routing and per-channel coordinator requests
- `src/dashboard/server.js` for the authenticated dashboard runtime

## Core Pipeline

1. Fetch all sources in bounded batches.
2. Collect source diagnostics and classify failures separately from empty feeds.
3. Deduplicate against delivery state and legacy compatibility data.
4. Apply middlewares such as scoring and semantic dedup.
5. Summarize with AI.
6. Claim one output at a time in configured topology order.
7. Commit each output result durably before the next output attempt starts.
8. Mark article and maintenance state only after successful completion.

The pipeline never claims exactly-once delivery. It provides bounded, operator-assisted recovery.

## Delivery State Model

### Cloudflare

Cloudflare delivery uses one SQLite-backed Durable Object per channel:

- `ChannelDeliveryCoordinator` owns request acceptance and recovery
- `SQLiteDeliveryStore` persists requests, deliveries, attempts, outputs, batches, reservations, maintenance rows, and operator actions in physical per-domain tables
- alarms are created only after accepted/claimed durable work exists, preserve an earlier wakeup, and repair stalled deadlines without authorizing a second live attempt
- request and operator mutations are idempotent and versioned
- `news_schema_migrations` records additive application migrations; schema v6 migrates legacy generic rows, materializes hot query fields, and adds exact indexes for retention, status, queue, and repair-alarm queries

### Local Node and Dashboard

Local runtimes use `LocalFileDeliveryStore`:

- one owned local state file
- atomically published unique-owner lock plus a canonical compatibility link to prevent multiple writers
- process identity includes the process start instant when the platform exposes it, preventing a reused PID from inheriting a stale writer lock
- stale legacy canonical-lock conversion requires every older runtime sharing the file to be stopped and drained before the upgrade starts
- a failed atomic save reloads the renamed durable snapshot or quarantines the store instead of allowing memory and disk to diverge
- read-only initialization for preview paths
- synchronous transactions only

`MemoryDeliveryStore` exists for tests and ephemeral inspection, not for real output paths.

## State Tables

| Table | Purpose |
|---|---|
| `channel_state` | Per-channel pause and mutation lease |
| `requests` | Accepted trigger/operator requests |
| `deliveries` | High-level delivery lifecycle |
| `attempts` | Generation and output attempts |
| `delivery_outputs` | Per-output result state |
| `articles` | Article ownership and terminal status |
| `delivery_reservations` | Digest request reservation and recovery |
| `day_batches` | Drip queue state and refill tracking |
| `batch_items` | Drip queue item order |
| `maintenance_outbox` | Legacy compatibility and token-maintenance replay |
| `operator_actions` | Idempotent operator audit records |
| `legacy_seen_compat` / `legacy_digest_compat` | Read-only legacy dedup compatibility |
| `coordinator_meta` | Immutable channel identity and durable last-request pointer |
| `canary_state` / `migration_state` | Canary evidence and legacy-import commit marker |
| `retention_state` | Once-per-day compaction marker |
| `news_schema_migrations` | Additive SQLite migration ledger |

Known runtime domains map to their own physical SQLite tables. `delivery_records` remains as a bounded compatibility table for migrating older generic rows and for non-domain test records; normal coordinator hot paths do not scan it. Store queries allowlisted materialized fields, cap individual pages at 1,000 rows, and use table-specific state/deadline/request/retention indexes. Aggregate status counts indexed state groups and reads only its requested page; the latest-batch summary is an indexed SQL aggregate rather than a capped item scan.

## Retention And Idempotency

- unresolved deliveries, attempts, requests, and referenced operator actions do not expire by age
- ordinary bulky terminal delivery data is removed after 30 days
- force/canary delivery records become compact replayable tombstones after 30 days
- ordinary completed request detail is removed after 90 days; force/canary/operator-retry requests become compact tombstones
- operator reasons are hashed before persistence; audit results contain bounded IDs/state only and become compact tombstones after 365 days
- permanent article dedup, safety suppression, and mutation-idempotency tombstones are independent of bulky-history retention

## Run Modes

| Mode | Behavior |
|---|---|
| `run` | Manual delivery run that bypasses cron gating |
| `cron` / `daemon` | Exact per-channel schedule execution |
| `preview` | Read-only delivery preview |
| `pause` / `resume` | Versioned channel state change |
| `retry-*` | Exact target recovery actions |
| `restore-topology` | Audited, versioned release of one config-matched topology blocker |

In Cloudflare:

- `quiesced` blocks mutation and token maintenance
- `bootstrap` permits health, status, queue, and operator pause only; preview is blocked because it performs source and AI provider I/O
- `active` enables the full configured delivery surface

## Channel Scheduling

`src/channels/definitions.js` builds channel configs from environment variables. `src/channels/runner.js` then executes due channels sequentially.

Important details:

- `BROADCAST_MODE` controls `digest` vs `drip`
- `CRON_SCHEDULE` and the per-channel cron overrides are exact five-field expressions
- source fetches are batched, but channel execution is sequential
- drip mode can carry unresolved work across days and can refill once when source health allows

## Security Model

### Cloudflare Worker

- `TRIGGER_SECRET` protects trigger, status, queue, and preview routes
- `OPERATOR_SECRET` protects force and recovery routes
- `OPERATOR_KEY_ID` is required for audit identity
- `Idempotency-Key` is required for manual and operator mutations
- `NEWS_RUNTIME_MODE` and `TOKEN_MAINTENANCE_MODE` control runtime exposure
- X output topology additionally requires `X_DESTINATION_ID`, a stable non-secret authenticated account identity

Aggregate `/status` exposes only redacted runtime mode, channel pause/version, durable last request, source warning, queue/unresolved counts, and paginated request/target projections. Exact request status and aggregate status both repair recovery alarms in active mode.

### Dashboard

- Basic auth uses separate trigger and operator credentials
- loopback is the default bind target
- non-loopback startup requires explicit HTTPS/origin/proxy policy
- responses are redacted and set `Cache-Control: no-store`

## Delivery Guarantees

- source failures are diagnostic, not silent
- AI generation is required before output delivery
- outputs are sequential with durable acknowledgement between calls
- stale attempts become recoverable states rather than disappearing
- ambiguous output is not automatically resent
- matching output configuration never auto-clears `blocked_topology`; an operator must invoke `restore-topology` or `abandon`
- paused channels do not accept new claims unless an audited paused-mutation override is supplied
- legacy compatibility replay is separate from authoritative delivery commits

## Rollout Stages

The recovery plan is intentionally staged:

1. quiesce old writers
2. validate a no-mutation Worker bundle
3. deploy the lifecycle/bootstrap bundle
4. keep every channel paused
5. run a single approved canary
6. resume only the approved channel

This is a controlled promotion path, not a one-shot deploy.

## Configuration Notes

| File | Role |
|---|---|
| `wrangler.quiesce.toml` | Reversible pre-lifecycle Worker bundle |
| `wrangler.toml` | Lifecycle/bootstrap Worker bundle |
| `wrangler.test.toml` | Worker test bundle |

Local and dashboard runtimes rely on:

- `DELIVERY_STORE_TYPE=file`
- `DELIVERY_STORE_PATH`
- `CACHE_TYPE` and `CACHE_PATH`
- `DASHBOARD_*` auth/origin/TLS/proxy settings

## Operational Boundaries

- Do not treat `MemoryCache` as a delivery store.
- Do not document exactly-once delivery.
- Do not claim parallel output sending.
- Do not route output-capable commands through a non-persistent cache.
- Do not merge rollout and recovery logic into source or output plugins.
