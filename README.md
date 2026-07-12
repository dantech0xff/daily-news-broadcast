# 🔥 NewsEngine — Portable Tech News Aggregator

Plugin-based news aggregation engine. Fetch from any source, summarize with any AI, send to any channel.

**Zero lock-in.** Swap sources, AI models, output channels with a single line of code.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          NewsEngine                               │
│                                                                  │
│  ┌─ Sources ──────┐   ┌─ AI ────────┐   ┌─ Outputs ──────────┐ │
│  │ RSS/Atom       │   │ Claude      │   │ Telegram           │ │
│  │ HTML Scraper   │──▶│ OpenAI      │──▶│ X (Twitter)        │ │
│  │ Hacker News    │   │ Groq        │   │ Facebook           │ │
│  │ Reddit         │   │ Gemini      │   │ Threads            │ │
│  │ Dev.to         │   │ Ollama      │   │ Slack / Discord    │ │
│  │ GitHub Trending│   │ OpenRouter  │   │ Email / Webhook    │ │
│  │ JSON API (any) │   │ Together    │   │ Markdown File      │ │
│  │ [Your Plugin]  │   │ Qwen/DeepSk│   │ [Your Plugin]      │ │
│  └────────────────┘   │ [Your own]  │   └────────────────────┘ │
│                       └─────────────┘                            │
│  ┌─ Cache ─────────┐  ┌─ Middleware ──────┐  ┌─ Channels ────┐ │
│  │ Memory          │  │ Filter by keyword │  │ Multi-channel │ │
│  │ File (JSON)     │  │ Semantic dedup    │  │ Per-channel   │ │
│  │ Redis           │  │ Score & rank      │  │   schedule    │ │
│  │ Cloudflare KV   │  │ [Your transform]  │  │ Drip / Digest │ │
│  └─────────────────┘  └───────────────────┘  └───────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
npm install
cp .env.example .env
# Edit .env with your tokens
```

### 2. Run

```bash
# One-time run
node src/adapters/node.js run

# Daemon mode with cron schedule
node src/adapters/node.js cron

# Preview (fetch + summarize, no send)
node src/adapters/node.js preview

# Deploy to Cloudflare Workers
wrangler deploy
```

### 3. Or use as library

```javascript
import { NewsEngine, FileCache } from './src/core/index.js';
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
  .useCache(new FileCache())
  .configure({ language: 'vi', style: 'digest' });

await engine.run();
```

## Project Structure

```
src/
├── core/                        # Engine core — platform agnostic
│   ├── contracts.js             # 4 plugin interfaces: Source, AI, Output, Cache
│   ├── engine.js                # Orchestrator (fluent builder, drip mode)
│   ├── caches.js                # Memory, File, Cloudflare KV, Redis
│   ├── prefixed-cache.js        # Namespaced cache wrapper per channel
│   ├── scoring.js               # Engagement + recency + credibility scoring
│   ├── semantic-dedup.js        # Bigram title similarity dedup
│   ├── grouping.js              # Category grouping for structured prompts
│   └── index.js                 # Barrel exports
│
├── sources/                     # Data source plugins
│   ├── rss.js                   # RSS/Atom feed parser (zero deps)
│   ├── html-scraper.js          # HTML scraper for blogs without RSS
│   ├── hackernews.js            # Hacker News (Algolia API)
│   ├── reddit.js                # Reddit (public JSON API)
│   ├── devto.js                 # Dev.to API + generic JSONAPISource
│   ├── github-trending.js       # GitHub Search API (popular repos)
│   ├── og-image.js              # og:image enrichment utility
│   └── index.js
│
├── ai/                          # AI summarization plugins
│   ├── claude.js                # Anthropic Claude (native API)
│   ├── openai-compat.js         # OpenAI-compatible: GPT, Groq, Gemini, Ollama, etc.
│   ├── create-ai.js             # Shared factory: provider string → AIPlugin
│   ├── platform-rules.js        # Platform-specific formatting rules
│   ├── _prompts.js              # Shared prompt templates (7 styles)
│   └── index.js
│
├── outputs/                     # Output channel plugins
│   ├── telegram.js              # Telegram Bot API (auto-split, markdown fallback)
│   ├── x.js                     # X/Twitter (OAuth 2.0, threaded tweets)
│   ├── facebook.js              # Facebook Page (Graph API)
│   ├── threads.js               # Threads (Meta, two-step publish)
│   ├── channels.js              # Slack, Discord, Email, Webhook, Markdown file
│   └── index.js
│
├── channels/                    # Multi-channel orchestration
│   ├── definitions.js           # Channel definitions from env vars
│   ├── runner.js                # Schedule matching + sequential execution
│   └── index.js
│
├── utils/                       # Shared utilities
│   └── token-store.js           # Encrypted KV token storage (OAuth tokens)
│
├── dashboard/                   # Web dashboard (Express)
│   ├── server.js                # HTTP server + SSE + API routes
│   ├── config-loader.js         # streams.config.json loader
│   ├── scheduler.js             # Cron job manager
│   ├── stream-runner.js         # Stream execution engine
│   └── public/                  # Frontend SPA
│
├── presets/                     # Pre-configured source bundles
│   └── index.js                 # bigTechBlogs(), communitySources(), aiMLBlogs(), etc.
│
├── adapters/                    # Runtime adapters
│   ├── cloudflare.js            # Cloudflare Worker (cron + HTTP)
│   └── node.js                  # Node.js CLI + daemon mode
│
├── Dockerfile
├── docker-compose.yml
├── wrangler.toml
└── .env.example
```

## Plugin System

### Contracts (Interfaces)

Every plugin extends one of 4 base classes from `src/core/contracts.js`:

| Contract | Methods | Purpose |
|----------|---------|---------|
| `SourcePlugin` | `.fetch(options)` → `Article[]` | Fetch articles from any source |
| `AIPlugin` | `.summarize(articles, options)` → `SummaryResult` | Summarize with any AI model |
| `OutputPlugin` | `.send(content, options)` → `SendResult` | Send results to any channel |
| `CachePlugin` | `.get()` `.set()` `.has()` `.delete()` | Dedup & state management |

### Article Schema

All source plugins return articles in this unified schema:

```javascript
{
  id: string,            // Unique ID (usually the URL)
  title: string,         // Article title
  url: string,           // Original link
  content: string,       // Content / description (plain text)
  source: string,        // Source name
  category?: string,     // Category
  author?: string,       // Author
  publishedAt?: Date,    // Publication date
  meta?: object,         // Arbitrary metadata (points, comments, icon, etc.)
}
```

## Available Plugins

### Sources

| Plugin | Auth | Description |
|--------|------|-------------|
| `RSSSource` | ❌ | RSS/Atom feed — works for most blogs |
| `HTMLScraperSource` | ❌ | HTML scraper — for blogs without RSS |
| `HackerNewsSource` | ❌ | HN Algolia API — filter by points, query |
| `RedditSource` | ❌ | Reddit JSON API — filter by subreddit, upvotes |
| `DevToSource` | ❌ | Dev.to API — filter by tag, reactions |
| `GitHubTrendingSource` | ❌ | GitHub Search API — trending repos by stars/language |
| `JSONAPISource` | ⚙️ | Generic JSON API — custom transform function |

### AI Providers

| Plugin | Factory / Config | Description |
|--------|-----------------|-------------|
| `ClaudeAI` | `provider: 'claude'` | Anthropic Claude (native API) |
| `OpenAICompatibleAI` | `provider: 'openai'` | OpenAI GPT models |
| | `provider: 'groq'` | Groq (ultra-fast inference) |
| | `provider: 'gemini'` | Google Gemini |
| | `provider: 'qwen'` | Alibaba Qwen (DashScope) |
| | `provider: 'deepseek'` | DeepSeek |
| | `provider: 'ollama'` | Ollama (local, offline) |
| | `provider: 'openrouter'` | OpenRouter (model marketplace) |
| | `provider: 'together'` | Together AI |
| | `provider: 'custom'` | Any OpenAI-compatible endpoint |

Use `createAI({ provider, apiKey, model })` factory or set `AI_PROVIDER` env var.

### Outputs

| Plugin | Description |
|--------|-------------|
| `TelegramOutput` | Telegram Bot API (auto-split >4096 chars, markdown fallback) |
| `XOutput` | X/Twitter (OAuth 2.0, threaded tweets, auto-split >280 chars) |
| `FacebookOutput` | Facebook Page (Graph API, link preview support) |
| `ThreadsOutput` | Threads by Meta (two-step publish, 500 char limit) |
| `SlackOutput` | Slack Incoming Webhook |
| `DiscordOutput` | Discord Webhook (auto-split >2000 chars) |
| `EmailOutput` | Email via Resend or SendGrid |
| `WebhookOutput` | Generic HTTP POST webhook |
| `MarkdownFileOutput` | Save as `.md` file (for static sites, GitHub) |

### Caches

| Plugin | Persistence | Best for |
|--------|-------------|----------|
| `MemoryCache` | ❌ In-memory | Testing, serverless |
| `FileCache` | ✅ JSON file | Local dev, Docker, VPS |
| `RedisCache` | ✅ Redis | Production, multi-instance |
| `CloudflareKVCache` | ✅ CF KV | Cloudflare Workers |

### Presets (Source Bundles)

| Preset | Sources | Description |
|--------|---------|-------------|
| `bigTechBlogs()` | 15 sources | Uber, Meta, Netflix, AWS, Cloudflare, etc. |
| `communitySources()` | 5 sources | HN, r/programming, r/ExperiencedDevs, Dev.to, GitHub Trending |
| `aiMLBlogs()` | 5 sources | OpenAI, DeepMind, HuggingFace, r/ML, HN AI |
| `aiNewsSources()` | 8 sources | TechCrunch AI, Verge AI, Ars Technica, VentureBeat, r/LocalLLaMA, r/singularity, r/artificial, HN AI |
| `aiDeepDiveSources()` | 6 sources | Simon Willison, Lilian Weng, Latent Space, Ahead of AI, One Useful Thing, Import AI |
| `devopsSources()` | 4 sources | Cloudflare, HashiCorp, r/devops, Dev.to |
| `mobileSources()` | 4 sources | Android Developers, r/androiddev, r/iOS, Dev.to |

## Usage Examples

### Minimal — 15 blogs → Claude → Telegram

```javascript
import { NewsEngine, FileCache } from './src/core/index.js';
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
  .useCache(new FileCache());

await engine.run();
```

### Multi-output — send to Telegram + Slack + Discord in parallel

```javascript
engine
  .addOutput(new TelegramOutput({ botToken: '...', chatId: '...' }))
  .addOutput(new SlackOutput({ webhookUrl: 'https://hooks.slack.com/...' }))
  .addOutput(new DiscordOutput({ webhookUrl: 'https://discord.com/api/webhooks/...' }));
```

### Swap AI — replace Claude with Groq (free, ultra-fast)

```javascript
import { groq } from './src/ai/index.js';

engine.useAI(groq('gsk_...'));
```

### Swap AI — run offline with Ollama

```javascript
import { ollama } from './src/ai/index.js';

engine.useAI(ollama('llama3.2'));
```

### Custom sources — mix presets + manual

```javascript
import { bigTechBlogs, communitySources } from './src/presets/index.js';
import { RSSSource, RedditSource } from './src/sources/index.js';

engine
  .addSource(...bigTechBlogs())
  .addSource(...communitySources())
  .addSource(new RSSSource({
    id: 'my-blog', name: 'My Company Blog',
    feedUrl: 'https://blog.mycompany.com/feed.xml',
    icon: '🏢', category: 'Internal',
  }))
  .addSource(new RedditSource({ subreddit: 'kotlin', minUpvotes: 30 }));
```

### Middleware — filter & transform articles before AI

```javascript
engine
  // Keep only articles matching relevant keywords
  .use(articles => articles.filter(a =>
    /kubernetes|docker|terraform/i.test(a.title + a.content)
  ))
  // Custom scoring
  .use(articles => articles.sort((a, b) =>
    (b.meta?.points || 0) - (a.meta?.points || 0)
  ).slice(0, 20));
```

### Newsletter style instead of digest

```javascript
engine.configure({ language: 'vi', style: 'newsletter' });
// Styles: 'digest' | 'hot_take' | 'bullet' | 'thread' | 'newsletter' | 'weekly' | 'mustread'
```

### Multi-channel — broadcast to multiple platforms

Use the `channels/` system to run multiple engine instances, each with its own schedule, prompt style, and output:

```javascript
import { defineChannels } from './src/channels/index.js';
import { runChannels } from './src/channels/runner.js';

const channels = defineChannels(process.env);
await runChannels(channels, { cache, force: true });
// Each channel has: id, schedule, mode (drip/digest), platform-specific prompt
```

Channels auto-activate when their required env vars are set. See `.env.example` for details.

### Config-driven streams (JSON)

Instead of code, define streams in `streams.config.json`:

```json
{
  "streams": [{
    "id": "morning-tech-digest",
    "cron": "0 7 * * *",
    "sources": [{ "type": "preset", "preset": "bigTechBlogs" }],
    "ai": {
      "provider": "claude",
      "apiKey": "$ANTHROPIC_API_KEY",
      "style": "digest",
      "audience": "nguoi lam IT Viet Nam: developers, engineers, product, data, security, operations, technical leaders",
      "platform": "telegram"
    },
    "outputs": [{ "type": "telegram", "config": { "botToken": "$TELEGRAM_BOT_TOKEN", "chatId": "$TELEGRAM_CHAT_ID" } }]
  }]
}
```

Run the dashboard to manage streams:

```bash
npm run dashboard
# http://localhost:3000 — monitor, manual trigger, SSE live updates
```

### Dry run — preview without sending

```javascript
const result = await engine.run({ dryRun: true });
console.log(result.content); // View digest content
console.log(result.stats);   // { sources: 15, articles: 23, ... }
```

## Writing Custom Plugins

### Custom Source

```javascript
import { SourcePlugin } from './src/core/contracts.js';

class NotionSource extends SourcePlugin {
  constructor(config) {
    super();
    this._config = config;
  }

  get id() { return 'notion'; }
  get name() { return 'Notion Database'; }
  get icon() { return '📓'; }

  async fetch(options = {}) {
    const { limit = 10 } = options;
    const res = await fetch(`https://api.notion.com/v1/databases/${this._config.databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._config.apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_size: limit }),
    });
    const data = await res.json();
    return data.results.map(page => ({
      id: page.id,
      title: page.properties.Name?.title?.[0]?.plain_text || '',
      url: page.url,
      content: '',
      source: this.name,
    }));
  }
}
```

### Custom AI Provider

```javascript
import { AIPlugin } from './src/core/contracts.js';
import { buildPrompt } from './src/ai/_prompts.js';

class MyLocalAI extends AIPlugin {
  get id() { return 'local-ai'; }
  get name() { return 'My Local Model'; }

  async summarize(articles, options = {}) {
    const prompt = buildPrompt(articles, options);
    const res = await fetch('http://localhost:8080/v1/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `${prompt.system}\n\n${prompt.user}`, max_tokens: 4096 }),
    });
    const data = await res.json();
    return { text: data.choices[0].text, model: 'local' };
  }
}
```

### Custom Output

```javascript
import { OutputPlugin } from './src/core/contracts.js';

class ZaloOutput extends OutputPlugin {
  get id() { return 'zalo'; }
  get name() { return 'Zalo OA'; }
  get maxLength() { return 2000; }

  async send(content) {
    const res = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': this._config.accessToken,
      },
      body: JSON.stringify({
        recipient: { user_id: this._config.userId },
        message: { text: content },
      }),
    });
    return { success: res.ok };
  }
}
```

## Testing

### Quick test — preview mode (no sending)

```bash
# Preview first channel (fetch + summarize, no send)
node src/adapters/node.js preview

# Preview specific channel
node src/adapters/node.js preview --channel telegram-main

# Force skip dedup cache
node src/adapters/node.js run --force
```

### Test individual presets

```bash
# Fetch articles from any preset
node -e "
import { aiNewsSources } from './src/presets/index.js';
for (const src of aiNewsSources()) {
  const articles = await src.fetch({ limit: 2 });
  console.log(src.name, '—', articles.length, 'articles');
}
"
```

### Dashboard (config-driven streams)

```bash
npm run dashboard
# http://localhost:3000 — monitor streams, manual trigger, live logs
```

### Cloudflare Workers dev

```bash
npx wrangler dev
# curl http://localhost:8787/preview
```

## Deployment Options

### Node.js (any VPS / Railway / Render / Fly.io)

```bash
node src/adapters/node.js cron
```

### Docker

```bash
docker compose up -d
```

### Cloudflare Workers

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put GEMINI_API_KEY
wrangler deploy
```

### AWS Lambda / Vercel / any serverless

```javascript
import { NewsEngine, MemoryCache } from './src/core/index.js';
// ... setup engine
export const handler = async () => engine.run();
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_PROVIDER` | ❌ | `claude`/`openai`/`groq`/`gemini`/`qwen`/`deepseek`/`ollama`/`openrouter`/`together`/`custom`/`none` |
| `AI_MODEL` | ❌ | Override default model for chosen provider |
| `ANTHROPIC_API_KEY` | Per AI | Claude API key |
| `OPENAI_API_KEY` | Per AI | OpenAI API key |
| `GROQ_API_KEY` | Per AI | Groq API key |
| `GEMINI_API_KEY` | Per AI | Google Gemini API key |
| `QWEN_API_KEY` | Per AI | Alibaba DashScope API key |
| `DEEPSEEK_API_KEY` | Per AI | DeepSeek API key |
| `TELEGRAM_BOT_TOKEN` | Per output | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Per output | Telegram chat/channel ID |
| `X_CLIENT_ID` | Per output | X/Twitter OAuth 2.0 client ID |
| `FB_PAGE_TOKEN` | Per output | Facebook Page access token |
| `FB_PAGE_ID` | Per output | Facebook Page ID |
| `THREADS_USER_ID` | Per output | Threads user ID |
| `TOKEN_ENCRYPTION_KEY` | Per output | Encryption key for OAuth tokens in KV |
| `CACHE_TYPE` | ❌ | `file` / `redis` / `memory` (default: `file`) |
| `CACHE_PATH` | ❌ | File cache path (default: `.cache/news.json`) |
| `REDIS_URL` | ❌ | Redis connection URL |
| `CRON_SCHEDULE` | ❌ | Cron expression (default: `0 7 * * *` = 14:00 VN) |
| `SUMMARY_LANGUAGE` | ❌ | Output is locked to Vietnamese with diacritics (`vi`) |
| `MAX_ARTICLES_PER_SOURCE` | ❌ | Default: `3` |
| `CONCURRENCY_LIMIT` | ❌ | Parallel fetch limit (default: `5`) |
| `DRIP_BATCH_SIZE` | ❌ | Articles per drip run (default: `5`) |
| `DRIP_DELAY_MS` | ❌ | Delay between drip articles in ms |
| `TRIGGER_SECRET` | ❌ | Auth secret for Cloudflare manual trigger |

### Engine Options

```javascript
engine.configure({
  concurrency: 5,              // Parallel source fetch
  maxArticlesPerSource: 5,     // Max articles per source
  language: 'vi',              // Output is always Vietnamese with diacritics
  style: 'digest',             // digest | hot_take | bullet | thread | newsletter | weekly | mustread
  audience: 'IT professionals',  // Target audience context for AI
  platform: 'telegram',       // Platform-specific formatting rules
  since: new Date('2025-01-01'), // Only articles after this date
});
```

## Cost Estimate

| Component | Cost |
|-----------|------|
| Claude API (Sonnet) | ~$0.003–0.01 / digest |
| Groq (free tier) | $0 (rate limited) |
| Ollama (local) | $0 (your hardware) |
| Cloudflare Worker | Free tier (100k req/day) |
| Telegram Bot API | Free |

## Dependencies

### Required
- `node-cron` — cron scheduling for Node.js adapter daemon mode
- `express` — dashboard web server

### Optional
- `dotenv` — .env file loading
- `redis` — only if using RedisCache
- `wrangler` — only for Cloudflare Workers deployment

### Zero deps for core
The core engine, all source parsers, AI clients, and output senders use only `fetch()` (native in Node 18+, CF Workers, Bun, Deno).

## License

[MIT](LICENSE)
