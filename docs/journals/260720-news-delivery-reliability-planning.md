# News Delivery Reliability Recovery Planning

**Date**: 2026-07-20 18:21
**Severity**: High
**Component**: Cloudflare delivery coordination and recovery
**Status**: Plan ready for implementation approval

## What Happened

We finished the planning/red-team session for the news delivery reliability recovery work and killed the original KV-only design. The actual failure mode was ugly: the engine could report success, mark articles seen, and drop drip items even when AI or output work had failed, which meant the queue could lie while work was still lost. The revised plan now routes every Cloudflare channel through one SQLite-backed Durable Object with an explicit claim/call/commit flow, plus a local owned store for Node/dashboard.

## The Brutal Truth

The KV-only idea was not good enough. It could not serialize scheduled/manual/reconcile races, and it could not atomically claim a remote mutation before external I/O. That is exactly how you get false success and lost-queue state, which is the kind of bug that burns days and still leaves operators guessing. This was frustrating because the problem was not subtle; the architecture was simply too weak for the mutation semantics we needed.

## Technical Details

The red-team rejection forced a hard boundary change: provider classification is separate from retry policy, operator authorization is separate from trigger/runtime mode, atomic claim is separate from output execution, and maintenance mirror replay is separate from the authoritative commit path. The plan also stages rollout instead of pretending one deploy is safe: quiesce old writers first, then the Durable Object lifecycle baseline, then a single-channel canary, then explicit resume. Rollback is a controlled pause-and-return-to-baseline action, not a blind revert.

## What We Tried

We evaluated KV-only coordination and rejected it for remote mutations. We kept the real boundary where it belongs: SQLite Durable Object claim/call/commit, a local owned store for non-Cloudflare runtime paths, and explicit classification for success, definitive failure, and ambiguous outcomes. No implementation, provider mutation, or deploy happened in this session. The result is an execution-ready planning artifact only.

## Root Cause Analysis

The existing false-success/lost-queue risk comes from advancing seen/queue state without confirmed per-output acknowledgement. Treating the repair as a cache problem would preserve a second failure mode: KV can hold state, but it cannot safely coordinate contested claims across trigger types, runtime modes, and provider retries.

## Lessons Learned

Separate the concerns or the system will lie:

- classify provider outcomes before deciding retry behavior
- require operator authority to be distinct from trigger authority
- claim durably before any remote call
- keep pause/runtime mode separate from mutation logic
- replay maintenance mirrors without letting them mutate the truth

## Next Steps

The plan is ready for implementation approval, but Daily Deals is still blocked on the reliability recovery work landing. Implementation must follow the staged rollout and recovery gates exactly; until then, nothing should mutate providers or production delivery state.
