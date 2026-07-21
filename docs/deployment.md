# Deployment

## Platform: Cloudflare Workers

Production URL: <https://news-engine.dan-tran.workers.dev>

The Worker is promoted in stages. The currently deployed pre-lifecycle stage is `quiesced`: health remains available, while scheduled delivery, manual mutations, token refresh, provider calls, and coordinator access are disabled.

## Deploy Commands

Validate the reversible quiesce artifact:

```bash
WRANGLER_LOG_PATH=/tmp/news-engine-quiesce-dry-run.log \
  npx wrangler deploy --dry-run --config wrangler.quiesce.toml
```

Deploy the reversible pre-lifecycle artifact:

```bash
WRANGLER_LOG_PATH=/tmp/news-engine-quiesce-deploy.log \
  npx wrangler deploy --config wrangler.quiesce.toml --strict \
  --message "quiesce before durable delivery migration"
```

Do not deploy `wrangler.toml` until the separate Durable Object lifecycle approval and pre-deploy archive/checksum gate are complete. Telegram canary and channel resume are later, independent approvals.

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
npx wrangler deployments status --config wrangler.quiesce.toml --json
```

For the quiesce stage, `/health` must report `status: "ok"` and `runtimeMode: "quiesced"`.

## Rollback

Before the Durable Object lifecycle begins, roll back only to the captured quiesce version:

```bash
npx wrangler rollback <quiesce-version-id> \
  --config wrangler.quiesce.toml \
  --message "restore verified pre-lifecycle quiesce"
```

After the Durable Object class is created, pre-lifecycle versions are no longer valid rollback targets. Use only the captured full-schema bootstrap version or redeploy its checksum-verified immutable artifact.
