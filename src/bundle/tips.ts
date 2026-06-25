import { PublicKey } from "@solana/web3.js";
import { getConnectionInstance } from "../utils/blockhash";
import { StreamWatcher } from "../stream/yellowstone";

export interface TipStats {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  fetchedAt: number;
  slot: number;
  allBalances: number[];
}

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1uw81sm8TBH",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

let cachedStats: TipStats | null = null;
let lastFetch = 0;
const CACHE_TTL_MS = 5000;

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export async function fetchTipStats(watcher: StreamWatcher): Promise<TipStats> {
  const now = Date.now();
  if (cachedStats && now - lastFetch < CACHE_TTL_MS) {
    return cachedStats;
  }

  const conn = getConnectionInstance();
  const pubkeys = JITO_TIP_ACCOUNTS.map((pk) => new PublicKey(pk));

  const accounts = await conn.getMultipleAccountsInfo(pubkeys, "confirmed");
  const balances = accounts.map((acc) => Number(acc?.lamports ?? 0));
  const sorted = [...balances].sort((a, b) => a - b);

  // On devnet, tip account balances are artificially inflated (accumulated over years).
  // Cap at realistic mainnet tip ranges: 1_000 – 500_000 lamports.
  const clamp = (v: number) => Math.min(Math.max(v, 1_000), 500_000);

  const stats: TipStats = {
    p25: clamp(percentile(sorted, 25)),
    p50: clamp(percentile(sorted, 50)),
    p75: clamp(percentile(sorted, 75)),
    p95: clamp(percentile(sorted, 95)),
    fetchedAt: now,
    slot: watcher.getCurrentSlot(),
    allBalances: balances,
  };

  cachedStats = stats;
  lastFetch = now;
  return stats;
}

export { JITO_TIP_ACCOUNTS };
