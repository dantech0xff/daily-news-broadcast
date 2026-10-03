# Deployment

Two deployments matter:

| Target | Status |
|---|---|
| Cloudflare Worker `news-engine` | Deployed; the current production runtime. Observed in `bootstrap` mode on 2026-10-03, so it is not posting on schedule. |
| Dashboard app on Dokploy behind Cloudflare Tunnel + Access | **Planned, not deployed.** The cutover that makes it the only engine for `telegram-main` has not happened. |

Secrets are only ever passed through environment variables. Never print them, paste them into chat, or write them to files, logs, docs, or pull requests.

## Platform: Cloudflare Workers

Production URL: <https://news-engine.dan-tran.workers.dev>

### Observed state (2026-10-03)

The Worker no longer matches the 2026-08-08 recovery snapshot further down:

- `GET /health` reports `status: "ok"`, `runtimeMode: "bootstrap"` (not `active`), build `cloudflare-aig-compat-byok-20260729`, and one channel.
- `GET /status?channel=telegram-main` (trigger secret, read during the 2026-10-03 preflight) reported `paused=false`, `mutationState=blocked_ambiguous`, and channel version `543`.
- The Worker is therefore **not posting on schedule**: `scheduled()` returns immediately unless the runtime mode is `active`, and `bootstrap` serves only health, status, queue, and `/control/pause`. The ambiguous item behind `blocked_ambiguous` would also hold delivery until an operator reconciles it.
- The channel itself is still unpaused in its Durable Object, so a later `active` deploy would start posting again. The cutover below pauses it explicitly first.

The rest of this section records how production got here. The dated snapshots are historical.

The Worker was promoted in stages. By 2026-08-08 production ran the post-lifecycle `active` runtime with the Telegram coordinator resumed. The SQLite Durable Object lifecycle, legacy KV import, one-message canary, and explicit per-channel resume are complete. Gemini generation through Cloudflare AI Gateway BYOK and the standard Telegram photo-caption delivery path were verified in production. Token maintenance remains disabled until separately approved.

Recovery state (2026-08-08, historical):

- Build: `cloudflare-aig-compat-byok-20260729` active at 100% traffic
- Runtime: `active`; `telegram-main` resumed and `mutationState=free`
- Incident request: scheduled request `b745b3d6d4383b92f61415f10df5528102fab661e200617a463cbe7a43d5ad18` completed `ambiguous` at `2026-08-05T16:02:21.024Z`
- Reconciliation evidence: public Telegram message `1549` appeared at `2026-08-05T16:02:24Z`, three seconds after the durable ambiguity was recorded, so retrying the output would have created a duplicate
- Recovery: output `261704f3b73e1df7147c655b309f134a8565cc875c876a36a7561d9c576f5a30` on delivery `046087cc696675ee56de71789ac2cbf10a7e09e84023120a0d35313d4fe94d8f` was resolved with versioned `confirm-delivered` and message ID `1549`
- Verification: channel version `432`, zero ambiguous outputs, zero maintenance dead letters, and repair request `3a6117a648ce73b0df465123a4067935fe1fd04f25c3e21d3cfdf0c0ec14ff7b` completed `success`
- Telegram delivery resumed with public messages `1552` and `1553` at `2026-08-08T02:20:38Z` and `2026-08-08T02:20:39Z`
- Queue snapshot after recovery: 29 items for `2026-08-05`, 16 remaining, 3 blocked; 33 generation-exhausted recovery targets remain non-ambiguous and were not retried to avoid stale bulk delivery

Previous AI Gateway recovery state (2026-07-29):

- Build: `cloudflare-aig-compat-byok-20260729`
- Active Worker artifact: `cloudflare-aig-compat-byok-20260729` at 100% traffic
- AI model: `gemini-3.5-flash-lite`
- Runtime: `active`; `telegram-main` remains resumed and mutation-free
- Health: `200 OK`
- AI Gateway: provider `google-ai-studio`, BYOK alias `default`; generation retry `ca8f38db39870f046c9050623bba2b7b7e8e96979d6575d7ef61c14596a27f9f` completed `success/generation_ready`
- Telegram delivery: repair alarm `f315b2be5a40fa1506c3b41cba0ae8ad6c1200a52de750f708fe7cf0fc11a1f6` completed `success` with `articles=1`, `outputs=1`
- Queue: 24 total, 23 remaining, 22 blocked; one item is `delivered`
- Safety: zero ambiguous outputs and zero maintenance dead letters

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

### Deploy Commands

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

`wrangler.toml` is the post-lifecycle bootstrap boundary. Do not use `wrangler.quiesce.toml` or any pre-lifecycle Worker version as a rollback target. Channel resume remains a separate versioned operator mutation; `telegram-main` was explicitly resumed after its successful canary. While the dashboard app owns the chat, do not deploy the Worker in `active` mode with `telegram-main` unpaused.

### Environment Variables

Non-secret Worker variables are checked into the selected Wrangler config, including runtime mode, pause defaults, operator audit identity, provider/model selection, delivery limits, and schedules.

Production secrets are stored with Wrangler and never committed:

- `CF_AIG_TOKEN`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TRIGGER_SECRET`
- `OPERATOR_SECRET`

`TRIGGER_SECRET` and `OPERATOR_SECRET` must be distinct. `OPERATOR_KEY_ID` is a non-secret audit identity declared in both production configs.

Production Gemini requests use Cloudflare AI Gateway BYOK when
`CF_AIG_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `AI_GATEWAY_ID` are all present.
The Google AI Studio key must be stored under the gateway's `default` provider
key alias (or selected with `AI_GATEWAY_BYOK_ALIAS`). Provider request payloads
are not logged and gateway response caching is bypassed. `GEMINI_API_KEY`
remains available only as the direct-provider fallback when gateway config is
completely absent.

### Custom Domain

No custom domain is configured. The deployment uses the account's `workers.dev` hostname.

### Verification

```bash
curl --fail-with-body --silent --show-error \
  https://news-engine.dan-tran.workers.dev/health
npx wrangler deployments status --config wrangler.toml --json
```

An active deployment reports `status: "ok"`, `runtimeMode: "active"`, and its build version in `buildVersion`; on 2026-10-03 `/health` reports `runtimeMode: "bootstrap"` (see the observed state above). The 2026-08-08 recovery snapshot reports `paused=false`, `mutationState=free`, channel version `432`, zero ambiguous outputs, zero maintenance dead letters, and 33 unresolved generation targets. The versioned `confirm-delivered` action is backed by public Telegram message `1549`; the following repair alarm completed successfully and produced messages `1552` and `1553`. The earlier AI Gateway recovery moved delivery `7cc7878559638127d33d5fc8647b0a0960a237eb6f242335e390d5bedf716fa2` from `generation_exhausted` to `ready`, after which its repair alarm completed one article and one output.

The approved canary request is `711970696f57497e948441831451f94eea1ea004ba8fcd4ef3a29f1b64c80a59`. Its terminal evidence is `completed/success`, delivery `30a1346a6862c7a2681b90828b52549d6df0875f1329592a8151c7a5a88eb20b`, with `articles=1` and `outputs=1`. Confirmation was read-only; no second canary POST was issued.

Resume completed at `2026-07-21T03:41:57Z` with the exact canary-era executable contract. Independent verification showed the intended 11-item queue unchanged immediately afterward, so it waits for scheduled delivery instead of draining during resume.

Historical note: the superseded rich-message transport was verified with one ordinary authenticated manual trigger, not an operator force. Request `86e1f2aaa04787a5a7d6fec7c526a9a38290504de45556c30c952ef148424c1c` completed `success` with one article and one output at `2026-07-21T07:54:50.911Z`. The current standard photo-caption transport is separately verified by the 2026-07-29 AI Gateway recovery evidence above.

### Worker Version Rollback

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

## Dokploy + Cloudflare (planned)

> **Status: planned, not deployed.** This section is the target design. Application IDs, verification output, and the cutover record are added here when the deployment and cutover happen.

```text
Browser ──HTTPS──> Cloudflare Access (email login or service token)
                     └─> Cloudflare Tunnel ──> cloudflared (Dokploy application)
                                                 └─> http://<appName>:3000 on dokploy-network
                                                       Dokploy application: this repository's Dockerfile
                                                       1 replica, volume at /data, no Traefik domain, no published port
```

### Dokploy Application

| Setting | Value | Why |
|---|---|---|
| Source | This repository over public HTTPS (`saveGitProvider`), branch `feat/dokploy-dashboard` until it is merged, then `master` | The repository is public: no GitHub App or deploy key |
| Build | Dockerfile `Dockerfile`, context `.` | Web build stage, then `node:24-alpine`; the `# syntax=docker/dockerfile:1` line and `COPY --chmod` need BuildKit |
| Replicas | 1 | One SQLite file, one scheduler |
| Swarm update config | `{ "Parallelism": 1, "Order": "stop-first" }` | Dokploy applications default to `start-first`, which would briefly run two schedulers on one database; the runtime lease is the second guard |
| Stop grace period | At least 135 s (`SHUTDOWN_WAIT_SECONDS` + 15 s) | SIGTERM waits for the run in flight; a kill in the middle of a send leaves an ambiguous output. Find the Swarm field in the instance's OpenAPI before deploying |
| Volume | A named volume (for example `content-radar-data`) at `/data` | Holds `content-radar.db`, `backups/`, and `news.json` across redeploys |
| Health check | `http://127.0.0.1:3000/healthz` (Swarm intervals are in nanoseconds) | The only unauthenticated route; `/api/health` needs an Access JWT |
| Domain and ports | None: no Traefik domain, no published port | Traefik publishes 80/443 on the VPS IP, so a Traefik route would let `curl -H "Host: <hostname>" http://<vps-ip>/` bypass Access |

Environment (names only; values are never committed or printed):

| Variable | Value |
|---|---|
| `NODE_ENV`, `HOST`, `PORT`, `DATA_DIR`, `CACHE_PATH` | Already set by the image: `production`, `0.0.0.0`, `3000`, `/data`, `/data/news.json` |
| `APP_MASTER_KEY` | 32 random bytes in base64, generated once and passed straight to the Dokploy API. The user keeps a copy in a password manager (it is visible in Dokploy's environment tab); losing it means re-entering every secret |
| `ACCESS_TEAM_DOMAIN` | `https://<auth_domain>` from `GET /accounts/{account_id}/access/organizations` |
| `ACCESS_AUD` | The `aud` of the Access application |
| `APP_OPERATOR_EMAILS`, `APP_VIEWER_EMAILS` | The people allowed in, by role |
| `APP_SERVICE_TOKEN_ROLES` | `<client-id>:operator` for the agent's service token, revoked or downgraded after the cutover |
| `PUBLIC_ORIGIN` | `https://<hostname>` |
| `CONTENT_SCAN_RETENTION_DAYS`, `RUN_HISTORY_RETENTION_DAYS`, `SHUTDOWN_WAIT_SECONDS` | Optional; defaults 30, 180, and 120 |

Dokploy's `saveEnvironment` replaces the whole environment string, and environment, mount, and Swarm changes apply only on the next deploy. Every channel starts paused, so deploying never posts anything.

### Cloudflare

Access exists before DNS, so the hostname is never reachable unprotected:

1. Team domain: `GET /accounts/{account_id}/access/organizations` returns `auth_domain`. The Zero Trust organization must already exist.
2. Login method: add a one-time PIN identity provider if the organization has none.
3. Reusable Access policies: allow by email (operators and viewers), plus a `non_identity` policy for the agent's service token.
4. A self-hosted Access application for the hostname with both policies; its `aud` becomes `ACCESS_AUD`.
5. A tunnel created through the API with `config_src: "cloudflare"`. Ingress: `http://<appName>:3000` (the Dokploy application's service name on `dokploy-network`) with `originRequest.access { required: true, teamName, audTag: [aud] }`, then a catch-all `http_status:404`.
6. `cloudflared` as a second Dokploy application: image `cloudflare/cloudflared` at a pinned version, `TUNNEL_TOKEN` from the tunnel token API (passed straight through), arguments `tunnel run`. Wait until the tunnel reports healthy.
7. DNS: a proxied CNAME from the hostname to `<tunnel-id>.cfargotunnel.com`.

Containers on `dokploy-network` can still reach the app directly, which is why the app verifies the Access JWT on every request itself.

The deploy needs these in the operator's environment: `DOKPLOY_URL` and `DOKPLOY_API_KEY` (Dokploy v0.29.5 or later); `CF_API_TOKEN` with edit rights on Cloudflare Tunnel, Access apps and policies, Access organizations and identity providers, Access service tokens, and Zone DNS; `CF_ACCOUNT_ID`; `CF_ZONE_ID`; the hostname; the operator emails; and the service token as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. Check variable names only; never echo their values.

### Verification Checklist

- Anonymous requests to `https://<hostname>/` and `/api/health` are stopped by Access: anything but app content is acceptable.
- With the service token headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`), `/api/health` returns 200, shows this instance holding the lease, and reports one channel, and `GET /api/channels/telegram-main/status` shows it paused with `cutoverRequired`.
- `curl -H "Host: <hostname>" http://<vps-ip>/` returns Traefik's 404, and no app port is published on the host.
- A redeploy keeps the data (no new seed, no repeated migration), and two containers never run at once.
- A person signs in through Access and the dashboard loads.

Backups: the app writes `VACUUM INTO` snapshots to `/data/backups/` before schema migrations. Off-site volume backups (Dokploy Volume Backups to S3 or R2) are not set up.

## Cutover Runbook (planned)

Goal: the dashboard app becomes the only engine posting to the `telegram-main` chat. The Worker and the app must never be active on the same chat: pause the Worker, verify, and only then resume the app.

**Gate.** All of these, in order:

1. The user signs in to the dashboard through Access.
2. The user enters the production secrets in the dashboard (bot token, chat ID, and the AI Gateway token or a Gemini API key) and assigns them to `telegram-main`.
3. Preview: `POST /api/channels/telegram-main/preview` returns content, nothing is sent, and the channel's status `version` is unchanged.
4. The user explicitly approves the cutover.

**Steps.**

1. Read the Worker channel version: `GET https://news-engine.dan-tran.workers.dev/status?channel=telegram-main` with `Authorization: Bearer $TRIGGER_SECRET`.
2. Pause the Worker channel: `POST /control/pause` with `Authorization: Bearer $OPERATOR_SECRET`, `Content-Type: application/json`, an `Idempotency-Key` header (for example `cutover-pause-telegram-main-<yyyymmdd>`), and the body `{"channelId":"telegram-main","expectedVersion":<version>,"reason":"Cutover to Dokploy"}`. Pause is accepted in `bootstrap` mode. On a version conflict, read the version again and retry once with a new key.
3. Read `/status` again and confirm `paused: true`. If the channel is not paused, stop: do not resume anything on Dokploy.
4. On the app (dashboard, or the API with the operator service token): set `notBefore` on `telegram-main` to the current UTC time with `PUT /api/channels/telegram-main` (body: the new `notBefore` and the config `version` from `GET /api/channels/telegram-main`), then resume it with `POST /api/channels/telegram-main/control/resume` (`idempotencyKey`, `expectedVersion` = `version` from `GET /api/channels/telegram-main/status`, `reason`).
5. Watch for up to 24 hours for the first delivered post: the next cron tick (`0 0-17 * * *` UTC) or an operator's manual run. Check the status, the run history, and the content library (`delivered` with a Telegram message ID).
6. Verify: the Worker is still paused; every article the app posted has a `publishedAt` at or after `notBefore`, or none; there are no new ambiguous outputs. If nothing posts within 24 hours, report the scan numbers (source health, articles rejected as `before_cutoff`) instead of moving the cutoff.
7. Afterwards the user may revoke or downgrade the agent's service token.

Record here once done: the cutover time, the Worker channel version after the pause, and the first delivery and message IDs. No secrets.

## Rollback Runbook (planned)

1. Pause `telegram-main` on the app: the dashboard, or `POST /api/channels/telegram-main/control/pause`, which never needs the runtime lease. To take the dashboard offline as well, stop the Dokploy application or delete the DNS record; the channel stays paused.
2. Only if the Worker should post again: it runs in `bootstrap` mode, where `/control/resume` is refused (only pause is accepted), and its `telegram-main` is `blocked_ambiguous`. It would post only after being redeployed in `active` mode and having the ambiguous item reconciled, which is outside this rollout and needs a user decision. After that, resume it with `POST /control/resume` (a new `Idempotency-Key`, the current `expectedVersion`, and a reason).
3. Never let both run active on the same chat.
