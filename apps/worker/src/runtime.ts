import { createInvokeTool, type ToolInvoker } from "@repo/gateway";
import type { Db } from "@repo/core";
import { createAgentRunner } from "./agent/agents.js";
import {
  createHybridClassifier,
  createLlmClassifier,
  createRuleBasedClassifier,
  type ClassificationModel,
} from "./agent/classifier.js";
import type { SupervisorDependencies } from "./agent/supervisor.js";
import type { IntentClassifierInput, WorkflowLevel } from "./agent/types.js";

const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_TIMEOUT_MS = 8_000;

export const CLASSIFIER_SYSTEM_PROMPT_V1 = `You classify Munshi customer-support messages for Indian payments.

Return JSON only with this shape:
{"intents":[{"intent":"<INTENT>","confidence":0.0-1.0,"entities":{...}}]}

Supported intents (use only these):
- UPI_PAYMENT_ISSUE
- REFUND_STATUS
- RECHARGE_ISSUE
- ACCOUNT_ISSUE
- WALLET_BALANCE
- WALLET_PAYMENT_TRACK
- WALLET_REFUND_TRACK
- COMPLAINT_CREATE
- COMPLAINT_STATUS

Entities (include only when present in the message; never invent IDs or amounts):
- transactionId: string reference
- refundId: string reference
- rechargeNumber: 10-digit Indian mobile
- complaintId: string reference
- amount: number in rupees
- relativeDate: today | yesterday | last_week | last_month

Rules:
- Prefer a single intent when one clearly fits.
- If the customer mentions Paytm wallet / wallet balance / wallet history / wallet refund, prefer WALLET_* intents over generic UPI or REFUND.
- Understand Hindi/English mix (Hinglish).
- Do not invent transaction, refund, complaint, or recharge identifiers.
- Always include confidence between 0 and 1.`;

function parseWorkflowLevel(raw: string | undefined): WorkflowLevel {
  const value = raw?.trim();

  if (value === "0") return 0;
  if (value === "2") return 2;
  return 1;
}

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
      signal: AbortSignal.timeout(SARVAM_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: CLASSIFIER_SYSTEM_PROMPT_V1,
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
    ? createHybridClassifier({
        rules,
        llm: createLlmClassifier(buildSarvamClassifierModel(apiKey), {
          fallback: rules,
        }),
      })
    : rules;

  const tools: ToolInvoker = createInvokeTool({ db, timeoutMs: 8_000 });

  return {
    classifier,
    runner: createAgentRunner(),
    tools,
    workflowLevel: parseWorkflowLevel(process.env.MUNSHI_WORKFLOW_LEVEL),
    confidenceThreshold: 0.5,
  };
}
