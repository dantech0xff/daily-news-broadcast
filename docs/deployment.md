# Deployment

## Platform: Cloudflare Workers

Production URL: <https://news-engine.dan-tran.workers.dev>

The Worker is promoted in stages. Production is currently on the post-lifecycle `active` runtime with the Telegram coordinator resumed. The SQLite Durable Object lifecycle, legacy KV import, one-message canary, and explicit per-channel resume are complete. Token maintenance remains disabled until separately approved.

Current verified state (2026-07-21):

- Build: `delivery-v2-20260721-1f8a755`
- Active Worker version: `22eca548-c08a-43dd-b329-8e66948d143b` at 100% traffic
- Runtime: `active`
- Channel: `telegram-main`, `paused=false`, `mutationState=free`, version `5`
- Legacy import: 113 keys accounted for, 14 queue items imported, source KV retained
- Telegram canary: one article and one output completed successfully
- Scheduled queue: 11 queued, 0 blocked; resumes only on due channel ticks
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

`/health` must report `status: "ok"`, `runtimeMode: "active"`, and build `delivery-v2-20260721-1f8a755`. Protected status must report `paused=false`, `mutationState=free`, channel version `5`, and zero ambiguous outputs, maintenance dead letters, and unresolved targets.

The approved canary request is `711970696f57497e948441831451f94eea1ea004ba8fcd4ef3a29f1b64c80a59`. Its terminal evidence is `completed/success`, delivery `30a1346a6862c7a2681b90828b52549d6df0875f1329592a8151c7a5a88eb20b`, with `articles=1` and `outputs=1`. Confirmation was read-only; no second canary POST was issued.

Resume completed at `2026-07-21T03:41:57Z` with the exact canary-era executable contract. Independent verification showed the intended 11-item queue unchanged immediately afterward, so it waits for scheduled delivery instead of draining during resume.

## Rollback

The verified post-lifecycle bootstrap rollback version is `0ccd198e-4f99-49dd-8aa1-1c2fcadfce4b`. It contains the same build identity, SQLite `ChannelDeliveryCoordinator` namespace, paused defaults, and disabled token maintenance:

```bash
npx wrangler rollback 0ccd198e-4f99-49dd-8aa1-1c2fcadfce4b \
  --config wrangler.toml --yes \
  --message "restore verified post-lifecycle bootstrap boundary"
```

Never roll back to a version from before the Durable Object class creation. If the captured bootstrap version is unavailable, stop and fix forward from the checksum-verified post-lifecycle artifact; do not rebuild an emergency rollback from a dirty working tree.
