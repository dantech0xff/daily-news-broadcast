# NewsEngine

Plugin-based news aggregation engine. It fetches articles from any source, summarizes them with any AI provider, and sends the result to any output channel.

Current delivery model:

- AI generation is required for any real delivery or preview run.
- Output attempts are sequential, not parallel, and each durable acknowledgement is committed before the next output starts.
- Delivery state is durable. The engine does not promise exactly-once delivery.
- `MemoryCache` is for tests and dry-run paths only. Output-capable commands require a persistent cache and a durable delivery store.

## Quick Start

### Install

```bash
npm install
cp .env.example .env
```

### Validate

```bash
npm test
```

### Run

```bash
npm run preview   # read-only preview, fetch + summarize, no send
npm run start     # manual run
npm run start:cron # exact per-channel cron daemon
npm run dashboard # dashboard runtime
```

The Node runtime supports Node.js `>=18`. Development and Workers verification require Node.js `>=22` because the pinned Wrangler/Vitest toolchain requires it. The checked-in Cloudflare configs are staged artifacts:

- `wrangler.test.toml` for local Worker tests
- `wrangler.quiesce.toml` for the reversible no-mutation quiesce bundle
- `wrangler.toml` for the lifecycle/bootstrap bundle with default pause

## Runtime Modes

| Command | Behavior | Notes |
|---|---|---|
| `run` | Manual run that bypasses cron gating | Not the same as force |
| `drip` | Alias of `run` | Each channel keeps its configured mode |
| `cron` | Exact per-channel cron daemon | Uses each channel timezone and schedule |
| `daemon` | Alias of `cron` | Same behavior |
| `preview` | Read-only preview | Mode-aware and non-mutating |
| `pause` / `resume` | Operator recovery controls | Require exact version, idempotency key, and reason |
| `retry-generation` / `retry-output` | Retry one exact unresolved item | Require exact target IDs and expected version |
| `restore-topology` | Clear one topology blocker after configuration is restored | Versioned and audited; matching configuration alone never clears the blocker |
| `confirm-delivered` / `abandon` | Resolve ambiguous or blocked items | Operator-only recovery actions |
| `retry-maintenance` | Replay one dead-letter maintenance mirror | Replay stays separate from authoritative delivery commits |

Force semantics are explicit:

- CLI force is `node src/adapters/node.js run --force --channel <id> --idempotency-key <key> --confirm-duplicate-risk`
- Worker force is operator-only and requires `Authorization: Bearer <OPERATOR_SECRET>`
- Scheduled runs remain schedule-driven; force does not silently change cron semantics

## Delivery Model

- Sources fetch into a bounded article set, then middlewares can score or filter it.
- AI summarizes the selected articles using the configured language, style, audience, and platform rules.
- Outputs are processed one at a time in configured topology order.
- Telegram photo posts use one rich message when the text exceeds the classic 1,024-character photo-caption limit; definitively unsupported Bot API versions fall back to the legacy photo-plus-text flow.
- After each output send, the state machine commits the result before the next output starts.
- Failures become classified states such as retryable, manual-retry-required, ambiguous, or exhausted.
- Drip mode persists a day batch, can carry unresolved items across days, and supports one bounded refill when source health allows it.
- Legacy `seen:*` and digest compatibility data are read conservatively and preserved during migration.
- Pausing blocks new claims. It does not cancel an external call that has already been issued.
- Cloudflare hot paths use physical per-domain SQLite tables and indexed bounded queries; the generic record table is retained only for schema migration and non-domain compatibility.
- Status reads count indexed recovery groups and fetch only the requested page. Queue summaries use one indexed aggregate, so neither path truncates after 1,000 records or performs one delivery read per batch item.
- Bulky terminal delivery detail is pruned after 30 days, ordinary terminal request detail after 90 days, and operator audit detail is minimized/compacted while permanent idempotency and safety tombstones remain replayable.

Before upgrading an existing local file store to the unique-owner lock protocol, stop and drain every older Node/dashboard process that can open the same store. The new runtime retains a canonical compatibility link while it owns the store, but converting a stale legacy canonical lock is intentionally a quiescence-only migration.

## Library Example

```javascript
import { NewsEngine, FileCache, LocalFileDeliveryStore } from './src/core/index.js';
import { bigTechBlogs } from './src/presets/index.js';
import { ClaudeAI } from './src/ai/index.js';
import { TelegramOutput } from './src/outputs/index.js';

const engine = new NewsEngine()
  .addSource(...bigTechBlogs())
  .useAI(new ClaudeAI({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .addOutput(new TelegramOutput({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  }))
  .useCache(new FileCache(process.env.CACHE_PATH))
  .useDeliveryStore(new LocalFileDeliveryStore(process.env.DELIVERY_STORE_PATH))
  .configure({
    channelId: 'telegram-main',
    language: 'vi',
    style: 'digest',
    platform: 'telegram',
  });

await engine.run();
```

## Core Layout

```text
src/
├── core/      Delivery contracts, state machine, caches, delivery store
├── sources/   RSS, HTML scraper, Hacker News, Reddit, Dev.to, GitHub trending
├── ai/        Claude + OpenAI-compatible providers and prompt builder
├── outputs/   Telegram, X, Facebook, Threads, Slack, Discord, Email, webhook, file
├── presets/   Source bundle factories
├── channels/  Multi-channel definitions and scheduler
├── dashboard/ Express dashboard and operator auth
└── adapters/  Node CLI and Cloudflare Worker entry points
```

## Recovery Commands

Exact local recovery commands use the same CLI and must include a stable idempotency key, an expected version, and a bounded reason:

```bash
node src/adapters/node.js pause \
  --channel telegram-main \
  --idempotency-key pause-telegram-main-001 \
  --expected-version 7 \
  --reason "Pause for recovery"

node src/adapters/node.js resume \
  --channel telegram-main \
  --idempotency-key resume-telegram-main-001 \
  --expected-version 8 \
  --reason "Resume after recovery"

node src/adapters/node.js retry-generation \
  --channel telegram-main \
  --idempotency-key retry-generation-001 \
  --expected-version 12 \
  --delivery-id <delivery-id> \
  --reason "Retry generation after timeout"

node src/adapters/node.js retry-output \
  --channel telegram-main \
  --idempotency-key retry-output-001 \
  --expected-version 12 \
  --delivery-id <delivery-id> \
  --output-key <output-key> \
  --reason "Retry output after ambiguous result"
```

`confirm-delivered`, `abandon`, and `retry-maintenance` follow the same pattern and require the exact target id plus the expected version.

`restore-topology` additionally verifies that the current configured destination fingerprint matches the delivery's durable fingerprint. A config match is read-only until this explicit operator action commits; it never auto-unblocks or calls a provider.

## Cloudflare Runtime

`src/adapters/cloudflare.js` routes requests through a per-channel Durable Object coordinator. The runtime modes are:

| Mode | Behavior |
|---|---|
| `quiesced` | No delivery mutations, no token maintenance, no coordinator access |
| `bootstrap` | Health/status/queue plus operator pause only; preview and provider work remain blocked |
| `active` | Full configured delivery and recovery surface |

Protected HTTP routes use separate trigger and operator secrets:

- `TRIGGER_SECRET` authorizes trigger/status/queue/preview routes
- `OPERATOR_SECRET` authorizes force/canary and recovery control routes
- `OPERATOR_KEY_ID` is required for audit identity
- `Idempotency-Key` is required for manual and operator mutations
- accepted trigger, force, canary, and generation/output retry responses include a request ID and directly pollable `/status` link
- generation/output retry endpoints atomically claim and persist the exact stage before returning `202`; provider work continues under the coordinator event, while alarms repair only durable claimed work

Aggregate status includes the runtime/pause state, durable last-request pointer, source degradation warning, queue counts, unresolved counts, and paginated redacted requests. Request-specific status also repairs a missing recovery alarm in active mode.

## Dashboard

The dashboard starts with persistent storage and Basic auth. It defaults to loopback binding and refuses unsafe non-loopback startup unless the TLS and proxy policy is explicit.

- trigger and operator credentials are separate
- responses are redacted and sent with `Cache-Control: no-store`
- same-origin checks guard mutations
- local preview stays read-only

## Testing

```bash
npm run test:node
npm run test:workers
npm test
node --check src/core/engine.js
node --check src/adapters/node.js
```

## Environment Overview

See `.env.example` for the full list. The important groups are:

- AI provider selection and API keys
- Telegram and optional multi-output credentials
- `X_DESTINATION_ID`, a stable non-secret authenticated X account identity used in delivery topology keys
- cache and delivery-store paths
- Cloudflare runtime mode and secrets
- dashboard auth, origin, TLS, and proxy controls
- drip batch sizing and timeout tuning

## Dependencies

- `node-cron` for the Node cron daemon
- `express` for the dashboard server
- `dotenv` optional for local `.env` loading
- `redis` optional for `RedisCache`

The core engine, parsers, AI clients, and outputs use native `fetch()` only.
