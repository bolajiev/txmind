import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { BuiltBundle } from "./builder";
import { StreamWatcher } from "../stream/yellowstone";

export interface SubmitResult {
  bundleId: string;
  submittedAt: number;
  submittedSlot: number;
  error?: string;
}

// Mainnet: submit to Jito block engine HTTP API
async function submitViaJito(
  built: BuiltBundle,
  watcher: StreamWatcher
): Promise<SubmitResult> {
  const base = (process.env.JITO_ENDPOINT || "https://mainnet.block-engine.jito.wtf").replace(/\/$/, "");
  const url = `${base}/api/v1/bundles`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [built.serializedTxs],
    }),
  });

  const json = (await res.json()) as any;

  if (json.error) {
    return {
      bundleId: built.bundleId,
      submittedAt: Date.now(),
      submittedSlot: watcher.getCurrentSlot(),
      error: `BUNDLE_REJECTED: ${json.error.message || JSON.stringify(json.error)}`,
    };
  }

  return {
    bundleId: json.result || built.bundleId,
    submittedAt: Date.now(),
    submittedSlot: watcher.getCurrentSlot(),
  };
}

// Devnet: Jito has no devnet block engine — submit the main transaction via RPC.
// The bundle is still fully constructed (main tx + tip tx); we submit the main tx
// to devnet so lifecycle tracking works with real slot numbers.
async function submitViaRpc(
  built: BuiltBundle,
  watcher: StreamWatcher
): Promise<SubmitResult> {
  const conn = new Connection(
    process.env.RPC_ENDPOINT || "https://api.devnet.solana.com",
    "confirmed"
  );

  // Decode the main transaction (first in the bundle)
  const txBytes = bs58.decode(built.serializedTxs[0]);
  const sig = await conn.sendRawTransaction(txBytes, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 0,
  });

  return {
    bundleId: `devnet-${sig.slice(0, 8)}-${Date.now()}`,
    submittedAt: Date.now(),
    submittedSlot: watcher.getCurrentSlot(),
  };
}

export async function submitBundle(
  built: BuiltBundle,
  watcher: StreamWatcher
): Promise<SubmitResult> {
  const isDevnet = (process.env.NETWORK || "devnet") === "devnet";

  try {
    if (isDevnet) {
      return await submitViaRpc(built, watcher);
    } else {
      return await submitViaJito(built, watcher);
    }
  } catch (err: any) {
    return {
      bundleId: built.bundleId,
      submittedAt: Date.now(),
      submittedSlot: watcher.getCurrentSlot(),
      error: `BUNDLE_REJECTED: ${err.message}`,
    };
  }
}
