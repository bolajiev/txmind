import "dotenv/config";
import { createStreamWatcher, StreamWatcher } from "./stream/yellowstone";
import { buildBundle, BuiltBundle } from "./bundle/builder";
import { submitBundle } from "./bundle/submit";
import { trackBundle, LifecycleEntry } from "./lifecycle/tracker";
import { appendEntry } from "./lifecycle/logger";
import { executeWithRetry, BuildAndSubmitFn } from "./utils/retry";
import { fetchBlockhash } from "./utils/blockhash";
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import bs58 from "bs58";

const SUBMISSION_COUNT = parseInt(process.env.SUBMISSION_COUNT || "10");
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS || "3");

function getWalletKeypair(): Keypair {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(pk));
}

function createMemoTransaction(
  recentBlockhash: string,
  payer: PublicKey,
  message: string
): VersionedTransaction {
  const memoProgramId = new PublicKey(
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"
  );
  const ix = new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
    programId: memoProgramId,
    data: Buffer.from(message),
  });

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  return tx;
}

async function buildAndSubmit(
  watcher: StreamWatcher,
  injectFailure: boolean,
  tipLamports: number  // agent-controlled tip
): Promise<{ bundle: BuiltBundle; entry: LifecycleEntry }> {
  const keypair = getWalletKeypair();

  // Fetch blockhash FIRST — if injecting failure, this is the one that will expire
  const { blockhash, lastValidBlockHeight } = await fetchBlockhash();

  if (injectFailure) {
    // Wait 155+ slots so the blockhash we already fetched becomes expired
    const targetSlot = watcher.getCurrentSlot() + 155;
    console.log(
      `  [failure injection] waiting until slot ${targetSlot} for blockhash expiry...`
    );
    while (watcher.getCurrentSlot() < targetSlot) {
      await new Promise((r) => setTimeout(r, 500));
    }
    // Intentionally use the now-expired blockhash (no re-fetch)
  }

  const currentSlot = watcher.getCurrentSlot();
  const tx = createMemoTransaction(
    blockhash,
    keypair.publicKey,
    `Jito bundle submission at slot ${currentSlot}`
  );
  tx.sign([keypair]);

  const built = await buildBundle({
    transaction: tx,
    tipLamports,  // use agent-decided tip
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    currentSlot,
  });

  const submitResult = await submitBundle(built, watcher);

  // If Jito rejected immediately, skip tracker — don't waste 90 seconds
  if (submitResult.error) {
    const entry: LifecycleEntry = {
      bundleId: submitResult.bundleId || built.bundleId,
      signature: built.signature,
      tipLamports: built.tipLamports,
      submittedAt: submitResult.submittedAt,
      submittedSlot: submitResult.submittedSlot,
      failedAt: Date.now(),
      failureType: "BUNDLE_REJECTED",
      failureDetail: submitResult.error,
      latency: { totalMs: Date.now() - submitResult.submittedAt },
      status: "failed",
    };
    return { bundle: built, entry };
  }

  const entry = await trackBundle(
    submitResult.bundleId || built.bundleId,
    built.signature,
    built.tipLamports,
    submitResult.submittedSlot,
    watcher
  );

  return { bundle: built, entry };
}

async function waitSlots(watcher: StreamWatcher, slots: number): Promise<void> {
  const target = watcher.getCurrentSlot() + slots;
  while (watcher.getCurrentSlot() < target) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  console.log("Starting Solana Transaction Stack...");
  console.log(`Network: ${process.env.NETWORK || "devnet"}`);
  console.log(`Submissions: ${SUBMISSION_COUNT}`);

  const keypair = getWalletKeypair();

  const watcher = createStreamWatcher(
    process.env.YELLOWSTONE_ENDPOINT!,
    process.env.YELLOWSTONE_TOKEN!,
    keypair.publicKey.toString()  // wallet pubkey for transaction filter
  );

  await watcher.waitForFirstSlot();
  console.log(`Stream connected, current slot: ${watcher.getCurrentSlot()}`);
  console.log(`Wallet: ${keypair.publicKey.toString()}`);

  for (let i = 0; i < SUBMISSION_COUNT; i++) {
    const shouldInjectFailure = i === 2 || i === 6;

    const upcoming = watcher.getUpcomingLeader();
    const leaderInfo = upcoming
      ? `next leader in ${upcoming.slotsUntilLeader} slot(s): ${upcoming.leader.slice(0, 8)}...`
      : "leader window: unknown";

    console.log(
      `\n[${i + 1}/${SUBMISSION_COUNT}] Submitting bundle${shouldInjectFailure ? " (failure injection — blockhash will expire)" : ""}...`
    );
    console.log(`  ${leaderInfo}`);

    try {
      // BuildAndSubmitFn receives tipLamports from the agent via executeWithRetry
      const fn: BuildAndSubmitFn = (tipLamports: number) =>
        buildAndSubmit(watcher, shouldInjectFailure, tipLamports);

      const entry = await executeWithRetry(fn, watcher, MAX_RETRY_ATTEMPTS);

      appendEntry(entry);
      console.log(
        `[${i + 1}/${SUBMISSION_COUNT}] ${entry.status.toUpperCase()} — sig: ${entry.signature.slice(0, 16)}... slot: ${entry.submittedSlot} tip: ${entry.tipLamports} lamports`
      );
      if (entry.failureType) {
        console.log(`  failure: ${entry.failureType} — ${entry.failureDetail}`);
      }
      if (entry.agentTipReasoning) {
        console.log(`  agent tip: ${entry.agentTipReasoning}`);
      }
      if (entry.agentRetryReasoning) {
        console.log(`  agent retry: ${entry.agentRetryReasoning}`);
      }
    } catch (err: any) {
      console.error(`[${i + 1}/${SUBMISSION_COUNT}] Error: ${err.message}`);
    }

    if (i < SUBMISSION_COUNT - 1) {
      await waitSlots(watcher, 5);
    }
  }

  watcher.stop();
  console.log("\nDone. See lifecycle-log.json");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
