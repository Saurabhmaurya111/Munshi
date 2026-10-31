import { INTENT_ORDER, getIntentDefinition } from "./intents.js";
import type { AgentTask, ValidatedIntent } from "./types.js";

export type BatchPlan =
  | { ok: true; batches: AgentTask[][] }
  | { ok: false; reason: string };

export function planTasks(intents: ValidatedIntent[]): AgentTask[] {
  const ordered = [...intents].sort(
    (left, right) => INTENT_ORDER.indexOf(left.intent) - INTENT_ORDER.indexOf(right.intent),
  );

  const tasks: AgentTask[] = ordered.map((intent, index) => ({
    taskId: `task-${index + 1}`,
    intent: intent.intent,
    agent: intent.agent,
    domain: intent.domain,
    entities: { ...intent.entities },
    dependsOn: [],
    missingEntities: [...intent.missingEntities],
    confidence: intent.confidence,
  }));

  for (const task of tasks) {
    const definition = getIntentDefinition(task.intent);

    if (!definition) {
      continue;
    }

    task.dependsOn = tasks
      .filter(
        (other) => other !== task && definition.dependsOnIntents.includes(other.intent),
      )
      .map((other) => other.taskId);
  }

  return tasks;
}

export function buildExecutionBatches(tasks: AgentTask[]): BatchPlan {
  const remaining = [...tasks];
  const completed = new Set<string>();
  const batches: AgentTask[][] = [];

  while (remaining.length > 0) {
    const batch = remaining.filter((task) =>
      task.dependsOn.every((dependency) => completed.has(dependency)),
    );

    if (batch.length === 0) {
      return {
        ok: false,
        reason: "task dependencies contain a cycle or an unknown task id",
      };
    }

    batches.push(batch);

    for (const task of batch) {
      completed.add(task.taskId);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }

  return { ok: true, batches };
}
