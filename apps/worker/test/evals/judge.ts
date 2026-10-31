import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  judgeVerdictSchema,
  type EvalScenario,
  type JudgeVerdict,
} from "../../../../evals/schema.js";
import type { SupervisorResponse } from "../../src/agent/types.js";
import { EVALS_ROOT } from "./load-scenarios.js";

const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_TIMEOUT_MS = 20_000;

export type JudgeModel = (prompt: {
  system: string;
  user: string;
}) => Promise<unknown>;

export type JudgeInput = {
  scenario: EvalScenario;
  response: SupervisorResponse;
  calledTools: string[];
};

export type LlmJudge = {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
};

let cachedRubric: string | undefined;

export async function loadJudgeRubric(): Promise<string> {
  if (cachedRubric) {
    return cachedRubric;
  }

  const rubricPath = path.join(EVALS_ROOT, "rubrics", "judge.md");
  cachedRubric = await readFile(rubricPath, "utf8");
  return cachedRubric;
}

export function buildJudgeUserPayload(input: JudgeInput): string {
  const mockFacts = Object.fromEntries(
    Object.entries(input.scenario.mockTools).map(([tool, result]) => [
      tool,
      result.state === "confirmed"
        ? { state: result.state, data: result.data }
        : result,
    ]),
  );

  return JSON.stringify(
    {
      customerMessage: input.scenario.input.message,
      runStatus: input.response.status,
      requiresCustomerInput: input.response.requiresCustomerInput,
      calledTools: input.calledTools,
      mockToolFacts: mockFacts,
      assistantReply: input.response.message,
      labelledExpect: {
        status: input.scenario.expect.status,
        escalate: input.scenario.expect.escalate,
        replyMustMatch: input.scenario.expect.replyMustMatch,
        replyMustNotMatch: input.scenario.expect.replyMustNotMatch,
      },
    },
    null,
    2,
  );
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

export function createLlmJudge(model: JudgeModel, rubric: string): LlmJudge {
  const system = `${rubric.trim()}\n\nYou are the offline eval judge for Munshi. Return JSON only.`;

  return {
    async judge(input: JudgeInput): Promise<JudgeVerdict> {
      const raw = await model({
        system,
        user: buildJudgeUserPayload(input),
      });
      return judgeVerdictSchema.parse(raw);
    },
  };
}

export function createSarvamJudgeModel(options: {
  apiKey: string;
  model?: string;
}): JudgeModel {
  const model = options.model?.trim() || "sarvam-105b";

  return async ({ system, user }) => {
    const response = await fetch(SARVAM_CHAT_URL, {
      method: "POST",
      signal: AbortSignal.timeout(SARVAM_TIMEOUT_MS),
      headers: {
        "api-subscription-key": options.apiKey,
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `sarvam_judge_http_${response.status}${detail ? `:${detail.slice(0, 200)}` : ""}`,
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("sarvam_judge_empty");
    }

    return parseJsonContent(content);
  };
}

export async function createSarvamJudgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmJudge | null> {
  if (env.EVAL_LLM_JUDGE?.trim() !== "1") {
    return null;
  }

  const apiKey = env.SARVAM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("EVAL_LLM_JUDGE=1 requires SARVAM_API_KEY");
  }

  const rubric = await loadJudgeRubric();
  return createLlmJudge(
    createSarvamJudgeModel({
      apiKey,
      model: env.SARVAM_MODEL,
    }),
    rubric,
  );
}
