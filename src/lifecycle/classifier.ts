export type FailureType =
  | "BLOCKHASH_EXPIRED"
  | "FEE_TOO_LOW"
  | "COMPUTE_EXCEEDED"
  | "BUNDLE_REJECTED"
  | "LEADER_SKIPPED"
  | "INSUFFICIENT_FUNDS"
  | "UNKNOWN";

export function classifyFailure(
  error: string | null,
  timeoutMs?: number
): FailureType {
  if (!error) return "UNKNOWN";

  const lowered = error.toLowerCase();

  if (timeoutMs && timeoutMs > 60_000) return "BLOCKHASH_EXPIRED";
  if (lowered.includes("blockhash")) return "BLOCKHASH_EXPIRED";
  if (lowered.includes("insufficientfunds")) return "INSUFFICIENT_FUNDS";
  if (lowered.includes("fee")) return "FEE_TOO_LOW";
  if (lowered.includes("compute")) return "COMPUTE_EXCEEDED";
  if (lowered.includes("bundle_rejected")) return "BUNDLE_REJECTED";
  if (lowered.includes("leader")) return "LEADER_SKIPPED";

  return "UNKNOWN";
}
