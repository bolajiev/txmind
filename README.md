# Solana Smart Transaction Stack

Production-grade Solana transaction infrastructure stack with Yellowstone gRPC streaming, Jito bundles, and a Qwen AI agent for operational decisions.

## Architecture

**Public architecture document (Notion):** https://habitual-tortoise-0d0.notion.site/Architecture-Document-38a878969a3c8041a133c216c5b79531

```
Yellowstone gRPC ──► Stream Watcher ──► Lifecycle Tracker
       │               (slot status        │
       │               drives confirmed/   ▼
       │               finalized)      Classifier
       │                                    │
  AI Agent (Qwen) ◄── Retry Orchestrator ◄─┘
       │                    │
       ▼                    ▼
  Tip Calculator ──► Bundle Builder ──► Jito Block Engine
                           │
                           ▼
                    lifecycle-log.json
```

## Modules

| Module | File | Purpose |
|--------|------|---------|
| Stream Watcher | `src/stream/yellowstone.ts` | Yellowstone gRPC client — slot tracking + commitment-stage callbacks |
| Tips | `src/bundle/tips.ts` | Fetch live Jito tip account balances, derive p25/p50/p75/p95 |
| Builder | `src/bundle/builder.ts` | Construct Jito bundle with agent-decided tip transaction |
| Submit | `src/bundle/submit.ts` | Submit bundle to Jito block engine |
| Tracker | `src/lifecycle/tracker.ts` | Track bundle through all commitment stages via stream |
| Classifier | `src/lifecycle/classifier.ts` | Map Solana errors to failure types |
| Logger | `src/lifecycle/logger.ts` | Append lifecycle entries to lifecycle-log.json |
| AI Agent | `src/agent/index.ts` | Qwen agent for tip sizing + retry decisions |
| Retry | `src/utils/retry.ts` | Agent-driven retry orchestration |
| Entrypoint | `src/index.ts` | Orchestrate 10 bundle submissions with failure injection |

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in your keys

# Build
npm run build

# Run (submits 10 bundles, generates lifecycle-log.json)
npm start

# Watch logs live
tail -f lifecycle-log.json
```

## Environment Variables

See `.env.example` for all required variables. Key ones:

- `RPC_ENDPOINT` — Solana RPC (devnet or mainnet)
- `YELLOWSTONE_ENDPOINT` / `YELLOWSTONE_TOKEN` — Helius LaserStream credentials (Yellowstone-compatible)
- `JITO_ENDPOINT` — Jito block engine endpoint (mainnet only; devnet uses RPC submission)
- `WALLET_PRIVATE_KEY` — Base58-encoded wallet private key
- `QWEN_API_KEY` — Qwen API key (DashScope)
- `QWEN_BASE_URL` — Qwen OpenAI-compatible base URL
- `QWEN_MODEL` — Model name (default: `qwen-plus`)

## Q&A

### Q1: What does the delta between `processed_at` and `confirmed_at` tell you about network health?

The processed→confirmed delta reflects how quickly 2/3 of stake weight votes on the block. A healthy Solana network confirms in 400–800ms after processing on mainnet; on devnet the validator set is smaller and more centralized so confirmations can arrive in under 100ms. 

From our live devnet run: entries 1–5 and 7–10 showed 0ms deltas (RPC detected the transaction at `confirmed` commitment on the first poll, meaning it was already confirmed); entry 6 (slot 471842245) showed 84ms — a genuine stream-pushed gap between the processed callback and the confirmed slot status event. Deltas consistently above 2 seconds on mainnet indicate vote latency, fork resolution pressure, or stake concentration issues during that epoch. Because each log entry records both `processedSlot` and `confirmedSlot` with Unix timestamps, you can cross-reference the exact block timing on Solscan at `https://solscan.io/tx/{signature}?cluster=devnet`.

### Q2: Why should you never use `finalized` commitment when fetching a blockhash?

Finalized blockhashes are ~32 slots behind the current chain tip (~13 seconds). A transaction submitted with a finalized blockhash has only ~120 remaining slots of validity (150 total minus the ~30 already elapsed by the time it's included). Under any congestion, this drastically increases expiry risk. This stack always fetches blockhashes at `confirmed` commitment — 1–2 slots behind the tip — giving the full ~150-slot validity window. This is why the failure injection in submissions 3 and 7 explicitly waits 155 slots before using the already-fetched blockhash: to demonstrate exactly this expiry boundary.

### Q3: What happens to your bundle if the Jito leader skips their slot?

Jito bundles are targeted at a specific leader's slot. If the leader skips (due to being offline, network partition, or deliberate skip), the bundle is not executed and is not forwarded to the next leader — bundle atomicity requires the specific leader to process it. The transaction itself may still land via normal TPU gossip if broadcast separately, but the bundle tip guarantee and atomic execution are lost. This stack classifies this as `LEADER_SKIPPED` when the expected leader slot passes with no `processed` confirmation arriving within 90 seconds via the hybrid RPC+stream tracker. The Qwen agent's `decideRetry` logic responds with `wait_slots` to target the next scheduled leader rather than retrying immediately.

## Failure Injection

Submissions 3 and 7 (index 2 and 6) inject deliberate `BLOCKHASH_EXPIRED` failures:
1. Fetch a blockhash at `confirmed` commitment
2. Wait 155+ slots for it to expire (Solana blockhashes expire after ~150 slots / ~60 seconds)
3. Submit the now-expired blockhash — the transaction will never process
4. The tracker detects no `processed` update within 90s → classifies as `BLOCKHASH_EXPIRED`
5. Qwen agent reasons about the failure and issues `refresh_blockhash` + optional `increase_tip`
6. The retry loop fetches a fresh blockhash and resubmits

## Stream-Based Lifecycle Tracking

This stack uses Yellowstone gRPC for all commitment tracking — `confirmTransaction` is never called.

The stream watcher subscribes at `CommitmentLevel.PROCESSED` to receive:
- **Slot updates** at all stages (status 0=processed, 1=confirmed, 2=finalized)
- **Transaction updates** filtered by wallet address, fired at the processed stage

When a transaction is first seen in the stream, a `processed` callback fires with the landing slot. The watcher maps that slot number and fires `confirmed` and `finalized` callbacks as subsequent slot status updates arrive. This gives sub-100ms event precision vs. 400–800ms per RPC poll.

## Lifecycle Log

Output is written to `lifecycle-log.json` with 10+ entries. Each entry contains:
- Bundle ID and transaction signature
- Timestamps and slot numbers for each commitment stage
- Latency breakdowns (submitToProcessed, processedToConfirmed, confirmedToFinalized)
- Failure classification (if applicable)
- Qwen agent reasoning for tip decisions (`agentTipReasoning`) and retry strategy (`agentRetryReasoning`)
