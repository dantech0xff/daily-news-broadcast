# AGENTS.md — NewsEngine

## Project Overview

**NewsEngine** is a plugin-based news aggregation system. It fetches articles from any data source, summarizes them with any AI model, and sends results to any output channel. The architecture is fully modular — every component is a swappable plugin.

This is NOT a monolithic app. It's a **composable engine** with a plugin registry pattern.

## Architecture

```
src/
├── core/                    # Engine core (NEVER depends on plugins)
│   ├── contracts.js         # 4 plugin interfaces: SourcePlugin, AIPlugin, OutputPlugin, CachePlugin
│   ├── engine.js            # NewsEngine orchestrator — fluent builder, pipeline executor
│   ├── caches.js            # 4 cache implementations: Memory, File, CloudflareKV, Redis
│   └── index.js             # Barrel exports
│
├── sources/                 # Source plugins (each extends SourcePlugin)
│   ├── rss.js               # RSSSource + createRSSSources() batch helper
│   ├── html-scraper.js      # HTMLScraperSource (regex-based, no cheerio)
│   ├── hackernews.js        # HackerNewsSource (Algolia API, no auth)
│   ├── reddit.js            # RedditSource (public JSON API, no auth)
│   ├── devto.js             # DevToSource + JSONAPISource (generic JSON adapter)
│   └── index.js
│
├── ai/                      # AI plugins (each extends AIPlugin)
│   ├── Codex.js            # ClaudeAI (Anthropic native API)
│   ├── openai-compat.js     # OpenAICompatibleAI + factory helpers: openai(), groq(), gemini(), ollama(), openRouter(), togetherAI()
│   ├── _prompts.js          # Shared prompt builder — buildPrompt(articles, {language, style})
│   └── index.js
│
├── outputs/                 # Output plugins (each extends OutputPlugin)
│   ├── telegram.js          # TelegramOutput (auto-split, markdown→plaintext fallback)
│   ├── channels.js          # SlackOutput, DiscordOutput, EmailOutput, WebhookOutput, MarkdownFileOutput
│   └── index.js
│
├── presets/                 # Pre-configured source bundles
│   └── index.js             # bigTechBlogs(), communitySources(), aiMLBlogs(), devopsSources(), mobileSources()
│
└── adapters/                # Runtime adapters (thin wrappers around NewsEngine)
    ├── cloudflare.js        # Cloudflare Worker: scheduled() + fetch() handlers
    └── node.js              # Node.js CLI: run | cron | preview commands
```

## Key Design Decisions

1. **Plugin contracts in `core/contracts.js`** — 4 abstract base classes. Every plugin must extend one. The engine type-checks plugins at registration time.
2. **Engine never imports from plugin directories** — `core/` has zero imports from `sources/`, `ai/`, `outputs/`. All wiring happens in adapters or user code.
3. **Fluent builder API** — `engine.addSource().useAI().addOutput().useCache().configure()` — all chainable, all return `this`.
4. **Pipeline flow** — `Fetch → Dedup → Middleware → AI Summarize → Send to all outputs`. Middleware is `(articles) => articles` transform functions injected via `.use()`.
5. **Zero external dependencies for core parsing** — RSS/HTML parsers use regex, no cheerio/xml2js. This keeps it Cloudflare Worker compatible.
6. **AI prompt system** — `_prompts.js` exports `buildPrompt()` which generates `{system, user}` pair based on language (`vi`/`en`) and style (`digest`/`bullet`/`thread`/`newsletter`). All AI plugins consume this.
7. **Presets are just factory functions** — they return `SourcePlugin[]` arrays. Users spread them into `.addSource()`.

## Plugin Contracts

### SourcePlugin (sources must implement)
```
get id → string
get name → string  
get icon → string (emoji, default '📰')
fetch({ limit?, since?, config? }) → Promise<Article[]>
```

### Article Schema (all sources must return this)
```
{ id, title, url, content, source, category?, author?, publishedAt?, meta? }
```

### AIPlugin (AI providers must implement)
```
get id → string
get name → string
summarize(articles, { language?, style?, systemPrompt?, maxTokens? }) → Promise<{ text, usage?, model? }>
```

### OutputPlugin (outputs must implement)
```
get id → string
get name → string
get maxLength → number (default Infinity)
send(content, options?) → Promise<{ success, messageId?, error?, meta? }>
```

### CachePlugin (caches must implement)
```
get(key) → Promise<string|null>
set(key, value, ttlMs?) → Promise<void>
has(key) → Promise<boolean>
delete(key) → Promise<void>
```

## Code Conventions

- **ES Modules only** — all files use `import/export`, `"type": "module"` in package.json
- **No TypeScript** — plain JS with JSDoc annotations for types
- **No build step** — runs directly via Node 18+ or Cloudflare Workers
- **Naming**: plugins use PascalCase class names, factory helpers use camelCase (`groq()`, `ollama()`)
- **Config injection** — plugins receive config in constructor, store as `this._config`
- **Error handling** — fetch operations use try/catch and return empty arrays on failure rather than throwing. AI and output plugins throw on failure (engine catches).
- **Concurrency** — engine batches source fetches by `options.concurrency`, uses `Promise.allSettled`, 500ms delay between batches

## Working With This Codebase

### Adding a new source plugin

1. Create `src/sources/my-source.js`
2. Export a class extending `SourcePlugin`
3. Implement `get id`, `get name`, `async fetch(options)`
4. `fetch()` must return `Article[]` matching the schema
5. Export from `src/sources/index.js`
6. Optionally add to a preset in `src/presets/index.js`

### Adding a new AI provider

1. If OpenAI-compatible API → add a new factory helper in `openai-compat.js` + register in `create-ai.js`
2. If custom API → create `src/ai/my-ai.js`, extend `AIPlugin`, implement `summarize()`
3. Use `buildPrompt()` from `_prompts.js` for consistent prompt formatting (supports `audience` param)
4. Export from `src/ai/index.js`
5. Add provider to `createAI()` switch in `src/ai/create-ai.js` (shared factory used by all adapters)

### Adding a new output channel

1. Create class extending `OutputPlugin` in `src/outputs/channels.js` or new file
2. Implement `get id`, `get name`, `get maxLength`, `async send(content)`
3. Engine auto-truncates content to `maxLength` before calling `send()`
4. If the output has message size limits (Telegram 4096, Discord 2000), implement splitting inside `send()`
5. Export from `src/outputs/index.js`

### Adding a new prompt style

1. Edit `src/ai/_prompts.js`
2. Add entry to `STYLES` object: `myStyle: { vi: (audience) => '...', en: (audience) => '...' }`
3. Use via `engine.configure({ style: 'myStyle' })`
4. Available built-in styles: `digest`, `bullet`, `thread`, `newsletter`, `weekly`, `mustread`

### Using content intelligence middlewares

```js
import { createScoringMiddleware, createSemanticDedupMiddleware } from './src/core/index.js';

engine
  .use(createScoringMiddleware({ maxArticles: 20 }))   // Score & rank
  .use(createSemanticDedupMiddleware({ threshold: 0.65 })); // Remove cross-source duplicates
```

Category grouping is automatic in `buildPrompt()` when articles have mixed categories.

### Modifying the pipeline

The engine pipeline in `engine.js` method `run()` is:
```
1. Check cache (already sent today?)
2. _fetchAll() — parallel fetch from all sources (with retry)
3. _dedup() — filter via cache
4. middlewares — user-injected transforms (scoring → semantic dedup → custom)
5. ai.summarize() — with audience context, grouped articles (or _fallbackFormat() if no AI)
5b. secondary language digest (if secondaryLanguage configured)
6. output.send() — parallel to all outputs
7. _markSent() — cache articles
```

### Adding a new preset

1. Edit `src/presets/index.js` — add factory function returning `SourcePlugin[]`
2. Register in `src/dashboard/stream-runner.js` → `PRESET_FACTORIES` map
3. Export from `src/presets/index.js`
4. Available presets: `bigTechBlogs`, `communitySources`, `aiMLBlogs`, `aiNewsSources`, `aiDeepDiveSources`, `devopsSources`, `mobileSources`

### Testing locally

```bash
# Preview mode — fetch + summarize, no sending
node src/adapters/node.js preview

# Preview specific channel
node src/adapters/node.js preview --channel telegram-main

# Force skip dedup cache
node src/adapters/node.js run --force

# Test individual preset fetch
node -e "
import { aiNewsSources } from './src/presets/index.js';
for (const src of aiNewsSources()) {
  const a = await src.fetch({ limit: 2 });
  console.log(src.name, '—', a.length, 'articles');
}
"

# Dashboard (config-driven streams)
npm run dashboard

# Cloudflare dev mode
npx wrangler dev
# Then: curl http://localhost:8787/preview
```

## File-Level Reference

| File | Exports | Notes |
|------|---------|-------|
| `core/contracts.js` | `SourcePlugin`, `AIPlugin`, `OutputPlugin`, `CachePlugin` | Abstract base classes |
| `core/engine.js` | `NewsEngine` | Main orchestrator with retry, bilingual support |
| `core/caches.js` | `MemoryCache`, `FileCache`, `CloudflareKVCache`, `RedisCache` | All extend CachePlugin |
| `core/scoring.js` | `createScoringMiddleware()` | Engagement + recency + credibility scoring |
| `core/semantic-dedup.js` | `createSemanticDedupMiddleware()` | Bigram title similarity dedup |
| `core/grouping.js` | `groupByCategory()` | Groups articles by category for structured prompts |
| `sources/rss.js` | `RSSSource`, `createRSSSources()`, `cleanHTML()` | Zero-dep XML parsing |
| `sources/html-scraper.js` | `HTMLScraperSource` | Regex-based HTML extraction |
| `sources/hackernews.js` | `HackerNewsSource` | Algolia API, configurable minPoints |
| `sources/reddit.js` | `RedditSource` | Public JSON API, configurable subreddit + minUpvotes |
| `sources/devto.js` | `DevToSource`, `JSONAPISource` | Dev.to API + generic JSON adapter |
| `sources/github-trending.js` | `GitHubTrendingSource` | GitHub Search API, recently active popular repos |
| `ai/Codex.js` | `ClaudeAI` | Anthropic native `/v1/messages` endpoint |
| `ai/openai-compat.js` | `OpenAICompatibleAI`, `openai()`, `groq()`, `gemini()`, `ollama()`, `openRouter()`, `togetherAI()` | One class, many providers |
| `ai/create-ai.js` | `createAI()` | Shared factory for all adapters |
| `ai/_prompts.js` | `buildPrompt()` | Editorial prompts with audience, grouping, 6 styles |
| `outputs/telegram.js` | `TelegramOutput` | Auto-split, markdown fallback |
| `outputs/channels.js` | `SlackOutput`, `DiscordOutput`, `EmailOutput`, `WebhookOutput`, `MarkdownFileOutput` | All extend OutputPlugin |
| `presets/index.js` | `bigTechBlogs()`, `communitySources()`, `aiMLBlogs()`, `devopsSources()`, `mobileSources()` | Return SourcePlugin[] |
| `adapters/cloudflare.js` | default export (Worker) | Thin wrapper: creates engine from env |
| `adapters/node.js` | CLI entry point | Commands: run, cron, preview, help |

## Environment Variables

```
# Required (depends on which plugins you use)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ANTHROPIC_API_KEY=

# Optional
OPENAI_API_KEY=
GROQ_API_KEY=
CACHE_TYPE=file          # file | redis | memory
CACHE_PATH=.cache/news.json
REDIS_URL=redis://localhost:6379
CRON_SCHEDULE=0 7 * * *  # 7:00 UTC = 14:00 VN
SUMMARY_LANGUAGE=vi
MAX_ARTICLES_PER_SOURCE=3
CONCURRENCY_LIMIT=5
```

## Dependencies

### Required
- `node-cron` — cron scheduling for Node.js adapter daemon mode

### Optional  
- `dotenv` — .env file loading
- `redis` — only if using RedisCache
- `wrangler` — only for Cloudflare Workers deployment

### Zero deps for core
The core engine, all source parsers, AI clients, and output senders use only `fetch()` (native in Node 18+, CF Workers, Bun, Deno).
