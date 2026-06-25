import { StreamWatcher } from "../stream/yellowstone";
import { FailureType, classifyFailure } from "./classifier";
import { getConnectionInstance } from "../utils/blockhash";

export type CommitmentStage =
  | "submitted"
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed"
  | "expired";

export interface LifecycleEntry {
  bundleId: string;
  signature: string;
  tipLamports: number;

  submittedAt: number;
  submittedSlot: number;

  processedAt?: number;
  processedSlot?: number;

  confirmedAt?: number;
  confirmedSlot?: number;

  finalizedAt?: number;
  finalizedSlot?: number;

  failedAt?: number;
  failureType?: FailureType;
  failureDetail?: string;

  latency: {
    submitToProcessed?: number;
    processedToConfirmed?: number;
    confirmedToFinalized?: number;
    totalMs?: number;
  };

  status: CommitmentStage;

  agentTipReasoning?: string;
  agentRetryReasoning?: string | null;
  retryAttempt?: number;
  retriedBundleId?: string;
}

export async function trackBundle(
  bundleId: string,
  signature: string,
  tipLamports: number,
  submittedSlot: number,
  watcher: StreamWatcher
): Promise<LifecycleEntry> {
  const entry: LifecycleEntry = {
    bundleId,
    signature,
    tipLamports,
    submittedAt: Date.now(),
    submittedSlot,
    latency: {},
    status: "submitted",
  };

  return new Promise((resolve) => {
    let resolved = false;

    const finish = (e: LifecycleEntry) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(expireTimer);
      clearInterval(rpcPollTimer);
      resolve(e);
    };

    // Hard timeout — blockhash expires after ~90s
    const expireTimer = setTimeout(() => {
      entry.status = "expired";
      entry.failedAt = Date.now();
      entry.failureType = "BLOCKHASH_EXPIRED";
      entry.failureDetail = "No processed update within 90s";
      entry.latency.totalMs = Date.now() - entry.submittedAt;
      finish(entry);
    }, 90_000);

    // Stream subscription — drives "confirmed" and "finalized" via slot status
    watcher.subscribeToSignature(signature, (commitment, slot, err) => {
      if (resolved) return;

      if (commitment === "processed" && !entry.processedAt) {
        entry.processedAt = Date.now();
        entry.processedSlot = slot;
        entry.latency.submitToProcessed = entry.processedAt - entry.submittedAt;
        entry.status = "processed";

        if (err) {
          entry.failedAt = Date.now();
          entry.failureType = classifyFailure(err);
          entry.failureDetail = err;
          entry.status = "failed";
          entry.latency.totalMs = entry.failedAt - entry.submittedAt;
          finish(entry);
          return;
        }
      }

      if (commitment === "confirmed" && !entry.confirmedAt) {
        entry.confirmedAt = Date.now();
        entry.confirmedSlot = slot;
        entry.latency.processedToConfirmed =
          entry.confirmedAt - (entry.processedAt || entry.submittedAt);
        entry.status = "confirmed";
      }

      if (commitment === "finalized" && !entry.finalizedAt) {
        entry.finalizedAt = Date.now();
        entry.finalizedSlot = slot;
        entry.latency.confirmedToFinalized =
          entry.finalizedAt - (entry.confirmedAt || entry.processedAt || entry.submittedAt);
        entry.latency.totalMs = entry.finalizedAt - entry.submittedAt;
        entry.status = "finalized";
        finish(entry);
      }
    });

    // RPC poll for "processed" — Helius LaserStream pushes slot updates but
    // not individual transaction data, so we use one RPC call/2s to find the
    // landing slot. Once found, the stream's slot-status updates take over
    // for "confirmed" and "finalized".
    const conn = getConnectionInstance();
    const rpcPollTimer = setInterval(async () => {
      if (resolved || entry.processedAt) {
        clearInterval(rpcPollTimer);
        return;
      }
      try {
        const res = await conn.getSignatureStatus(signature, {
          searchTransactionHistory: false,
        });
        if (res.value !== null) {
          clearInterval(rpcPollTimer);
          const slot = res.context.slot;
          const txErr = res.value.err;
          watcher.notifyTransactionLanded(
            signature,
            slot,
            txErr ? JSON.stringify(txErr) : null
          );
        }
      } catch {
        // RPC hiccup — keep polling
      }
    }, 2000);
  });
}
