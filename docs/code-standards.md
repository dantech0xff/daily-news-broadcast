# Code Standards

## Runtime Baseline

- Use ES modules only.
- Target Node.js runtime `>=18` and Cloudflare Workers with `nodejs_compat`; use Node.js `>=22` for the pinned Workers development/test toolchain.
- Avoid a build step for runtime code.
- Keep core behavior runnable with native `fetch()` only.

## Naming

| Element | Convention | Example |
|---|---|---|
| Files | `kebab-case` | `openai-compat.js` |
| Classes | PascalCase | `NewsEngine`, `TelegramOutput` |
| Factories | `camelCase` | `groq()`, `buildPrompt()` |
| Private fields | `_` prefix | `this._config` |
| Internal helper files | `_` prefix | `_prompts.js` |

## Plugin Contracts

Every plugin extends one of the four base classes in `src/core/contracts.js`.

```javascript
class MySource extends SourcePlugin {
  constructor(config) {
    super();
    this._config = config;
  }

  get id() { return 'my-source'; }
  get name() { return 'My Source'; }
  async fetch(options = {}) { /* return Article[] */ }
}
```

Rules:

- source plugins return no more than the requested bounded `Article[]` and propagate the supplied AbortSignal through all provider I/O
- AI plugins summarize the exact bounded article selection they receive, honor the supplied AbortSignal, and return `{ text, usage?, model? }`
- output plugins honor operation identity, bounded article snapshots, AbortSignal, and `singleMutation`, then return a classified `SendResult` object
- cache plugins must support `get`, `set`, `has`, and `delete`
- output plugins expose a stable `deliveryKey`; set `supportsSingleMutation=true` only when one call can guarantee at most one provider mutation

### Plugin Operation Context

- `signal` is the engine-owned operation deadline. Source, AI, and output plugins must pass it to provider requests and response readers, stop retry/sleep loops, and settle promptly after abort.
- `requestId`, `deliveryId`, and `attemptId`, when supplied, are opaque durable correlation identities. Use `attemptId` as a provider idempotency key when the provider supports it; never parse identities or use them as credentials.
- AI receives an engine-selected bounded article set. Real delivery/recovery output calls receive the durable projected `articles` snapshot and, for drip mode, the matching `article` view. Plugins treat snapshots as read-only and must not refetch content to expand them.
- `singleMutation=true` is an output-only safety contract: no splitting, fallback, or internal retry may issue a second provider mutation. A plugin that cannot guarantee this must fail before mutation; `supportsSingleMutation` must remain false.
- Abort is cooperative and cannot undo provider work already accepted. A non-cooperative provider-side late completion cannot be cancelled or committed after the engine deadline; it remains conservatively ambiguous and blocks automatic resend until operator reconciliation.
- Canonical output results classify `meta.deliveryState` as `success`, `definitive_failure`, or `ambiguous`, and `meta.retryDisposition` as `automatic`, `manual`, or `never`. Legacy/unclassified failures fail closed as ambiguous/manual; the state machine alone decides retry behavior.

## Reliability Rules

| Layer | Standard |
|---|---|
| Source fetch | Honor the operation signal; catch failures and return an empty result or bounded diagnostic failure instead of throwing |
| Source diagnostics | Prefer bounded diagnostics over silent failures |
| AI summarize | Honor the operation signal and exact bounded selection; throw on failure so the engine can classify the durable attempt |
| Output send | Honor signal and single-mutation policy; throw or return a classified result, with timeout/unknown completion treated as ambiguous |
| Delivery store | Use synchronous transactions only; do not perform external I/O inside a transaction |
| Durable queries | Use allowlisted `query`/`count` filters and bounded indexed pages on hot paths; reserve full-table iteration for compatibility tooling only |
| Local lock upgrade | Stop and drain every older process sharing the store before stale canonical-lock conversion; never perform this compatibility migration during a rolling mixed-version start |
| Output order | Sequential, not parallel; commit each attempt before the next call |
| Retry handling | Respect `deliveryState` and `retryDisposition`; do not invent extra semantics |

## Concurrency And State

- Source fetches are batched by channel concurrency with a short delay between batches.
- Channels run sequentially in the runner to avoid resource contention.
- Cloudflare delivery uses one Durable Object per channel.
- Local Node/dashboard delivery uses one owned file store per process.
- Cloudflare domain records use physical SQLite tables with an application migration ledger and materialized hot-query columns.
- `MemoryCache` is acceptable for tests and dry-run preview, but not for output-capable paths.
- Preview is read-only for delivery state, not a no-op AI path.
- Retention must preserve unresolved references and compact idempotency/safety tombstones before removing bulky terminal detail.

## Security And Redaction

- Treat article text, URLs, and metadata as untrusted input.
- Redact secrets, private URLs, and large opaque values from status and error surfaces.
- Use distinct trigger and operator credentials.
- Dashboard responses must send `Cache-Control: no-store`.
- Non-loopback dashboard startup must satisfy the HTTPS/origin/proxy policy.

## Configuration

- Read environment variables in the adapter layer.
- Pass config objects downward into channels and plugins.
- Keep runtime defaults in checked-in config files, not in ad hoc shell state.
- `DELIVERY_STORE_TYPE=file` is the only local delivery-store mode.
- `NEWS_RUNTIME_MODE` controls quiesced, bootstrap, and active behavior in Cloudflare.
- X output configuration requires the stable non-secret `X_DESTINATION_ID`; never derive delivery topology from a logical channel label alone.

## Testing And Verification

- Run the narrowest useful test first.
- Use `npm run test:node`, `npm run test:workers`, and `npm test` for contract coverage.
- Use `node --check` on touched runtime files when the change affects execution paths.
- Verify docs against source before publishing them.
- Prefer preserving behavior and fixing the contract rather than weakening tests.
