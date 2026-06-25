import { StreamWatcher } from "../stream/yellowstone";
import { BuiltBundle } from "../bundle/builder";
import { LifecycleEntry } from "../lifecycle/tracker";
import { decideTip, decideRetry } from "../agent";
import { fetchTipStats } from "../bundle/tips";

// BuildAndSubmitFn receives the agent-decided tip so the agent actually controls it
export interface BuildAndSubmitFn {
  (tipLamports: number): Promise<{ bundle: BuiltBundle; entry: LifecycleEntry }>;
}

export async function executeWithRetry(
  buildAndSubmitFn: BuildAndSubmitFn,
  watcher: StreamWatcher,
  maxAttempts: number = 3
): Promise<LifecycleEntry> {
  const recentFailures: LifecycleEntry[] = [];
  let lastEntry: LifecycleEntry | null = null;
  let lastRetryReasoning: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentSlot = watcher.getCurrentSlot();
    const tipStats = await fetchTipStats(watcher);

    // Agent decides the tip — this is the actual tip used in the bundle
    const tipDecision = await decideTip(tipStats, currentSlot, recentFailures);

    // Apply tip multiplier from previous retry decision if available
    let effectiveTip = tipDecision.tipLamports;
    if (lastEntry?.agentRetryReasoning && attempt > 0) {
      // tipDecision already reflects updated network state, trust it
    }

    const result = await buildAndSubmitFn(effectiveTip);

    lastEntry = result.entry;
    lastEntry.agentTipReasoning = tipDecision.reasoning;
    // Carry forward retry reasoning from previous attempt so the final
    // returned entry always has agentRetryReasoning when retries occurred.
    if (lastRetryReasoning) {
      lastEntry.agentRetryReasoning = lastRetryReasoning;
    }

    if (result.entry.status === "finalized" || result.entry.status === "confirmed") {
      return result.entry;
    }

    recentFailures.push(result.entry);

    if (attempt < maxAttempts - 1) {
      const freshTipStats = await fetchTipStats(watcher);
      const retryDecision = await decideRetry(
        result.entry,
        freshTipStats,
        watcher.getCurrentSlot(),
        attempt + 1
      );

      lastRetryReasoning = retryDecision.reasoning;
      lastEntry.agentRetryReasoning = retryDecision.reasoning;

      if (!retryDecision.shouldRetry) {
        return result.entry;
      }

      if (retryDecision.action === "wait_slots" && retryDecision.waitSlots) {
        const targetSlot = watcher.getCurrentSlot() + retryDecision.waitSlots;
        while (watcher.getCurrentSlot() < targetSlot) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }

  return lastEntry!;
}
