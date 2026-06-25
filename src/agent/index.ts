import OpenAI from "openai";
import { TipStats } from "../bundle/tips";
import { LifecycleEntry } from "../lifecycle/tracker";

const client = new OpenAI({
  apiKey: process.env.QWEN_API_KEY || "",
  baseURL: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

const MODEL = process.env.QWEN_MODEL || "qwen-plus";

export interface AgentTipDecision {
  tipLamports: number;
  reasoning: string;
  confidence: "low" | "medium" | "high";
  basedOn: "p25" | "p50" | "p75" | "p95";
}

export interface AgentRetryDecision {
  shouldRetry: boolean;
  reasoning: string;
  action: "refresh_blockhash" | "increase_tip" | "wait_slots" | "abort";
  newTipMultiplier?: number;
  waitSlots?: number;
}

const SYSTEM_PROMPT = `You are an operational AI agent managing Solana transaction submissions.
You observe real network data and make decisions about tip sizing and retry strategy.
You must reason explicitly before deciding. Never guess — base decisions on the data provided.
Respond only in valid JSON matching the requested schema. No markdown, no preamble.`;

export async function decideTip(
  tipStats: TipStats,
  currentSlot: number,
  recentFailures: LifecycleEntry[]
): Promise<AgentTipDecision> {
  const failureSummary = recentFailures
    .map(
      (f, i) =>
        `[${i + 1}] type=${f.failureType} tip=${f.tipLamports} slot=${f.submittedSlot}`
    )
    .join("\n");

  const userPrompt = `Current network state:
- Slot: ${currentSlot}
- Tip p25: ${tipStats.p25} lamports
- Tip p50: ${tipStats.p50} lamports
- Tip p75: ${tipStats.p75} lamports
- Tip p95: ${tipStats.p95} lamports
- Recent failures (last 5): ${recentFailures.length}

Recent failure summary:
${failureSummary || "No recent failures"}

Decide how much to tip for the next bundle submission.
Consider: landing probability vs cost.
If recent bundles have been failing due to low tips, step up.
If recent bundles are landing cleanly, stay conservative.

Respond with JSON:
{
  "tipLamports": <number>,
  "reasoning": "<explain your logic>",
  "confidence": "low|medium|high",
  "basedOn": "p25|p50|p75|p95"
}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content || "";
    const parsed = JSON.parse(content);
    return {
      tipLamports: parsed.tipLamports || tipStats.p50,
      reasoning: parsed.reasoning || "Fallback to p50",
      confidence: parsed.confidence || "medium",
      basedOn: parsed.basedOn || "p50",
    };
  } catch (err) {
    return {
      tipLamports: tipStats.p50,
      reasoning: `Agent unavailable, using p50 fallback: ${err}`,
      confidence: "low",
      basedOn: "p50",
    };
  }
}

export async function decideRetry(
  failedEntry: LifecycleEntry,
  tipStats: TipStats,
  currentSlot: number,
  attemptNumber: number
): Promise<AgentRetryDecision> {
  const userPrompt = `A bundle has failed. Decide what to do before retrying.

Failed bundle:
- Failure type: ${failedEntry.failureType || "UNKNOWN"}
- Failure detail: ${failedEntry.failureDetail || "N/A"}
- Original tip: ${failedEntry.tipLamports} lamports
- Submitted at slot: ${failedEntry.submittedSlot}
- Current slot: ${currentSlot}
- Attempt number: ${attemptNumber}

Current tip stats:
- p50: ${tipStats.p50} lamports
- p75: ${tipStats.p75} lamports

Decide the retry strategy. Reason step by step.

Respond with JSON:
{
  "shouldRetry": true|false,
  "reasoning": "<step by step reasoning>",
  "action": "refresh_blockhash|increase_tip|wait_slots|abort",
  "newTipMultiplier": <number or null>,
  "waitSlots": <number or null>
}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content || "";
    const parsed = JSON.parse(content);
    return {
      shouldRetry: parsed.shouldRetry ?? true,
      reasoning: parsed.reasoning || "Retry with adjustments",
      action: parsed.action || "refresh_blockhash",
      newTipMultiplier: parsed.newTipMultiplier ?? undefined,
      waitSlots: parsed.waitSlots ?? undefined,
    };
  } catch (err) {
    return {
      shouldRetry: true,
      reasoning: `Agent unavailable, fallback retry: ${err}`,
      action: "refresh_blockhash",
    };
  }
}
