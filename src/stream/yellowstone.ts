import Client, {
  SubscribeRequest,
  SubscribeUpdate,
  CommitmentLevel,
} from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";
import { getConnectionInstance } from "../utils/blockhash";

export interface SlotUpdate {
  slot: number;
  leader: string;
  slotsUntilLeader: number;
}

export interface SignatureCallback {
  (commitment: string, slot: number, err?: string | null): void;
}

export interface StreamWatcher {
  getCurrentSlot(): number;
  getUpcomingLeader(): SlotUpdate | null;
  subscribeToSignature(sig: string, cb: SignatureCallback): void;
  // Called by tracker when RPC confirms a transaction landed — records the
  // slot so stream slot-status updates can drive confirmed/finalized callbacks.
  notifyTransactionLanded(sig: string, slot: number, err: string | null): void;
  waitForFirstSlot(): Promise<void>;
  stop(): void;
}

export function createStreamWatcher(
  endpoint: string,
  token: string,
  walletPubkey?: string
): StreamWatcher {
  let currentSlot = 0;
  let upcomingLeaderCache: SlotUpdate | null = null;
  let running = true;

  // sig → registered callbacks
  const activeSubs = new Map<string, SignatureCallback[]>();
  // sig → landing slot
  const txSlotMap = new Map<string, number>();
  // sig → commitment stages already fired
  const calledCommitments = new Map<string, Set<string>>();
  // slot → highest commitment status reached (0=processed, 1=confirmed, 2=finalized)
  const slotStatus = new Map<number, number>();

  const client = new Client(endpoint, token, {
    grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
  });

  function fireCallback(
    sig: string,
    commitment: string,
    slot: number,
    err: string | null
  ) {
    const called = calledCommitments.get(sig);
    if (called?.has(commitment)) return;

    if (!calledCommitments.has(sig)) calledCommitments.set(sig, new Set());
    calledCommitments.get(sig)!.add(commitment);

    const callbacks = activeSubs.get(sig);
    if (callbacks) {
      for (const cb of callbacks) cb(commitment, slot, err);
    }

    if (commitment === "finalized") {
      txSlotMap.delete(sig);
      calledCommitments.delete(sig);
      activeSubs.delete(sig);
    }
  }

  async function refreshLeaderSchedule() {
    try {
      const conn = getConnectionInstance();
      const schedule = await conn.getLeaderSchedule();
      if (!schedule || Object.keys(schedule).length === 0) return;
      // Find the next scheduled slot after current
      let nextSlot = Infinity;
      let nextLeader = "";
      for (const [leader, slots] of Object.entries(schedule)) {
        for (const s of slots) {
          if (s > currentSlot && s < nextSlot) {
            nextSlot = s;
            nextLeader = leader;
          }
        }
      }
      if (nextLeader) {
        upcomingLeaderCache = {
          slot: nextSlot,
          leader: nextLeader,
          slotsUntilLeader: nextSlot - currentSlot,
        };
      }
    } catch {
      // Non-critical — leader schedule is best-effort
    }
  }

  async function connectStream() {
    try {
      await client.connect();
      const stream = await client.subscribe();

      const txFilter: { [key: string]: { vote: boolean; failed: boolean; accountInclude: string[]; accountExclude: string[]; accountRequired: string[] } } = {};
      if (walletPubkey) {
        txFilter["walletFilter"] = {
          vote: false,
          failed: true,
          accountInclude: [walletPubkey],
          accountExclude: [],
          accountRequired: [],
        };
      }

      const request: SubscribeRequest = {
        accounts: {},
        slots: {
          all_slots: { filterByCommitment: false },
        },
        transactions: txFilter,
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        // PROCESSED level so we receive slot updates at all stages (0/1/2)
        // and transaction notifications as soon as they're processed
        commitment: CommitmentLevel.PROCESSED,
      };

      await new Promise<void>((resolve, reject) => {
        stream.write(request, (err: Error | null | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });

      stream.on("data", (data: SubscribeUpdate) => {
        if (!running) return;

        // --- Slot updates drive commitment stage tracking ---
        if (data.slot) {
          const slot = Number(data.slot.slot);
          const status = data.slot.status;
          // Yellowstone slot statuses: 0=processed, 1=confirmed, 2=finalized
          // Helius LaserStream also sends 3=first_shred_received, 4=completed — ignore those

          if (status === 0 && slot > currentSlot) {
            currentSlot = slot;
          }

          // Only track the three commitment stages we care about
          if (status === 0 || status === 1 || status === 2) {
            const prev = slotStatus.get(slot) ?? -1;
            if (status > prev) {
              slotStatus.set(slot, status);
            }
          }

          const commitmentName =
            status === 0 ? "processed" : status === 1 ? "confirmed" : status === 2 ? "finalized" : null;

          // Fire callbacks only for confirmed (1) and finalized (2)
          if (commitmentName && status >= 1 && status <= 2) {
            for (const [sig, txSlot] of txSlotMap.entries()) {
              if (txSlot === slot) {
                fireCallback(sig, commitmentName, slot, null);
              }
            }
          }

          // Clean up old slot status entries (keep last 200 slots)
          if (slotStatus.size > 200) {
            const oldest = Math.min(...slotStatus.keys());
            slotStatus.delete(oldest);
          }
        }

        // --- Transaction data fires "processed" and records sig→slot ---
        if (data.transaction) {
          const sigBytes = data.transaction.transaction?.signature;
          if (sigBytes) {
            const sig = bs58.encode(sigBytes);

            // Only process if we have an active subscription for this sig
            if (!activeSubs.has(sig)) return;

            const slot = Number(data.transaction.slot);
            const err = data.transaction.transaction?.meta?.err ?? null;

            // Record landing slot
            txSlotMap.set(sig, slot);

            // Fire processed callback
            fireCallback(sig, "processed", slot, err ? String(err) : null);

            // If this slot has already advanced, fire those callbacks now
            const reached = slotStatus.get(slot) ?? -1;
            if (reached >= 1) {
              fireCallback(sig, "confirmed", slot, null);
            }
            if (reached >= 2) {
              fireCallback(sig, "finalized", slot, null);
            }
          }
        }
      });

      stream.on("error", (err: Error) => {
        process.stderr.write(`Stream error: ${err.message}\n`);
        if (running) setTimeout(connectStream, 1000);
      });

      stream.on("end", () => {
        if (running) setTimeout(connectStream, 2000);
      });

      refreshLeaderSchedule();
    } catch (err) {
      process.stderr.write(`Connect failed: ${err}\n`);
      if (running) setTimeout(connectStream, 2000);
    }
  }

  connectStream();

  return {
    getCurrentSlot(): number {
      return currentSlot;
    },

    getUpcomingLeader(): SlotUpdate | null {
      return upcomingLeaderCache;
    },

    subscribeToSignature(sig: string, cb: SignatureCallback): void {
      if (!activeSubs.has(sig)) {
        activeSubs.set(sig, []);
      }
      activeSubs.get(sig)!.push(cb);
    },

    notifyTransactionLanded(sig: string, slot: number, err: string | null): void {
      if (!activeSubs.has(sig)) return;
      txSlotMap.set(sig, slot);
      fireCallback(sig, "processed", slot, err);
      // If this slot already reached confirmed/finalized, fire those now
      const reached = slotStatus.get(slot) ?? -1;
      if (reached >= 1) fireCallback(sig, "confirmed", slot, null);
      if (reached >= 2) fireCallback(sig, "finalized", slot, null);
    },

    async waitForFirstSlot(): Promise<void> {
      while (currentSlot === 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    stop(): void {
      running = false;
    },
  };
}
