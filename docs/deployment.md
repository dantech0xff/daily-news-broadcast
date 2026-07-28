# Deployment

## Platform: Cloudflare Workers

Production URL: <https://news-engine.dan-tran.workers.dev>

The Worker is promoted in stages. Production is currently on the post-lifecycle `active` runtime with the Telegram coordinator resumed. The SQLite Durable Object lifecycle, legacy KV import, one-message canary, and explicit per-channel resume are complete. Standard Telegram photo captions are deployed; provider-level verification will occur on the next scheduled news item. Token maintenance remains disabled until separately approved.

Current incident state (2026-07-28):

- Build: `gemini-3.5-flash-lite-20260728`
- Active Worker version: `5838041c-e79d-4ea3-81b2-9a6dcdb4a3b7` at 100% traffic
- AI model: `gemini-3.5-flash-lite`
- Runtime: `active`; `telegram-main` remains resumed and mutation-free
- Health: `200 OK`
- AI preview: `500 internal_error`; the provider request remains classified as HTTP 400
- Queue: 21 total, 21 remaining, 18 blocked in `generation_exhausted`
- No backlog recovery action has been issued

Previous verified delivery state (2026-07-21):

- Build: `telegram-caption-v1-20260721-204a8e0`
- Active Worker version: `0ff1cb56-db9d-4341-9ae5-3b71f7783bd2` at 100% traffic
- Runtime: `active`
- Channel: `telegram-main`, `paused=false`, `mutationState=free`, version `17`
- Legacy import: 113 keys accounted for, 14 queue items imported, source KV retained
- Telegram canary: one article and one output completed successfully
- Standard photo-caption code: deployed; live provider check pending the next scheduled item
- Scheduled queue: 11 total, 5 remaining, 0 blocked
- Token maintenance: disabled

## Deploy Commands

Validate the post-lifecycle bootstrap and active-paused artifacts:

```bash
WRANGLER_LOG_PATH=/tmp/news-engine-bootstrap-dry-run.log \
  npx wrangler deploy --dry-run --config wrangler.toml
WRANGLER_LOG_PATH=/tmp/news-engine-active-paused-dry-run.log \
  npx wrangler deploy --dry-run --config wrangler.active-paused.toml
```

Deploy active code without resuming the durable channel:

```bash
WRANGLER_LOG_PATH=/tmp/news-engine-active-paused-deploy.log \
  npx wrangler deploy --config wrangler.active-paused.toml --strict \
  --message "deploy active runtime while delivery remains paused"
```

`wrangler.toml` is now the post-lifecycle bootstrap boundary. Do not use `wrangler.quiesce.toml` or any pre-lifecycle Worker version as a rollback target. Channel resume remains a separate versioned operator mutation; `telegram-main` was explicitly resumed after its successful canary.

## Environment Variables

Non-secret Worker variables are checked into the selected Wrangler config, including runtime mode, pause defaults, operator audit identity, provider/model selection, delivery limits, and schedules.

Production secrets are stored with Wrangler and never committed:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TRIGGER_SECRET`
- `OPERATOR_SECRET`

`TRIGGER_SECRET` and `OPERATOR_SECRET` must be distinct. `OPERATOR_KEY_ID` is a non-secret audit identity declared in both production configs.

## Custom Domain

No custom domain is configured. The deployment uses the account's `workers.dev` hostname.

## Verification

```bash
curl --fail-with-body --silent --show-error \
  https://news-engine.dan-tran.workers.dev/health
npx wrangler deployments status --config wrangler.toml --json
```

`/health` must report `status: "ok"`, `runtimeMode: "active"`, and build `gemini-3.5-flash-lite-20260728`. Protected status currently reports `paused=false`, `mutationState=free`, channel version `195`, zero ambiguous outputs, zero maintenance dead letters, and 18 unresolved generation targets. Delivery recovery is not verified until AI preview succeeds and the blocked backlog is explicitly reconciled.

The approved canary request is `711970696f57497e948441831451f94eea1ea004ba8fcd4ef3a29f1b64c80a59`. Its terminal evidence is `completed/success`, delivery `30a1346a6862c7a2681b90828b52549d6df0875f1329592a8151c7a5a88eb20b`, with `articles=1` and `outputs=1`. Confirmation was read-only; no second canary POST was issued.

Resume completed at `2026-07-21T03:41:57Z` with the exact canary-era executable contract. Independent verification showed the intended 11-item queue unchanged immediately afterward, so it waits for scheduled delivery instead of draining during resume.

Historical note: the superseded rich-message transport was verified with one ordinary authenticated manual trigger, not an operator force. Request `86e1f2aaa04787a5a7d6fec7c526a9a38290504de45556c30c952ef148424c1c` completed `success` with one article and one output at `2026-07-21T07:54:50.911Z`. This evidence does not verify the current standard photo-caption transport, which still requires an approved deployment check.

## Rollback

The immediate pre-caption active version is `d3882fb8-01f0-460d-9ef9-ffd5891692a1`. It remains on the same post-lifecycle Durable Object contract and can be restored if the standard caption transport causes a production regression:

```bash
npx wrangler rollback d3882fb8-01f0-460d-9ef9-ffd5891692a1 \
  --config wrangler.active-paused.toml --yes \
  --message "restore previous Telegram transport"
```

The verified post-lifecycle bootstrap rollback version is `0ccd198e-4f99-49dd-8aa1-1c2fcadfce4b`. It preserves the SQLite `ChannelDeliveryCoordinator` namespace, paused defaults, and disabled token maintenance:

```bash
npx wrangler rollback 0ccd198e-4f99-49dd-8aa1-1c2fcadfce4b \
  --config wrangler.toml --yes \
  --message "restore verified post-lifecycle bootstrap boundary"
```

Never roll back to a version from before the Durable Object class creation. If the captured bootstrap version is unavailable, stop and fix forward from the checksum-verified post-lifecycle artifact; do not rebuild an emergency rollback from a dirty working tree.
