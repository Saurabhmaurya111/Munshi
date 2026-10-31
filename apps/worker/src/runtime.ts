import { createInvokeTool, type ToolInvoker } from "@repo/gateway";
import type { Db } from "@repo/core";
import { createAgentRunner } from "./agent/agents.js";
import {
  createLlmClassifier,
  createRuleBasedClassifier,
  type ClassificationModel,
} from "./agent/classifier.js";
import type { SupervisorDependencies } from "./agent/supervisor.js";
import type { IntentClassifierInput } from "./agent/types.js";

const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";

function buildSarvamClassifierModel(apiKey: string): ClassificationModel {
  const model = process.env.SARVAM_MODEL?.trim() || "sarvam-105b";

  return async (input: IntentClassifierInput) => {
    const response = await fetch(SARVAM_CHAT_URL, {
      method: "POST",
      headers: {
        "api-subscription-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You classify Munshi support messages for Indian payments (UPI, refunds, recharge, account, complaints). Return JSON only:
{"intents":[{"intent":"UPI_PAYMENT_ISSUE"|"REFUND_STATUS"|"RECHARGE_ISSUE"|"ACCOUNT_ISSUE"|"COMPLAINT_CREATE"|"COMPLAINT_STATUS","confidence":0-1,"entities":{...}}]}
Entities may include transactionId, refundId, rechargeNumber, complaintId, amount (rupees number), relativeDate (today|yesterday|last_week|last_month).
Only use supported intents. Prefer one intent when possible. Understand Hindi/English mix.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              message: input.message,
              customerId: input.authenticatedContext.customerId,
              recentEvents: input.recentEvents ?? [],
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`sarvam_http_${response.status}${detail ? `:${detail.slice(0, 200)}` : ""}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("sarvam_empty");
    }

    // Models sometimes wrap JSON in markdown fences.
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  };
}

export function createWorkerDependencies(db: Db): SupervisorDependencies {
  const rules = createRuleBasedClassifier();
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  const classifier = apiKey
    ? createLlmClassifier(buildSarvamClassifierModel(apiKey), {
        fallback: rules,
      })
    : rules;

  const tools: ToolInvoker = createInvokeTool({ db, timeoutMs: 8_000 });

  return {
    classifier,
    runner: createAgentRunner(),
    tools,
    workflowLevel: 0,
  };
}
