import { INTENT_ORDER, getIntentDefinition } from "./intents.js";
import { ENTITY_SCHEMAS } from "./schemas.js";
import type { AgentTask, ValidatedIntent } from "./types.js";

export type BatchPlan =
  | { ok: true; batches: AgentTask[][] }
  | { ok: false; reason: string };

function applyFacts(
  entities: Record<string, unknown>,
  facts: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...entities };

  for (const [name, schema] of Object.entries(ENTITY_SCHEMAS)) {
    if (merged[name] !== undefined || facts[name] === undefined) {
      continue;
    }

    const parsed = schema.safeParse(facts[name]);

    if (parsed.success) {
      merged[name] = parsed.data;
    }
  }

  return merged;
}

function taskIdFor(intent: string, used: Set<string>): string {
  const base = `task-${intent}`;

  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  let candidate = `${base}-${suffix}`;

  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  used.add(candidate);
  return candidate;
}

/**
 * Builds ordered agent tasks from validated intents.
 * COMPLAINT_CREATE depends on any investigation intents present in the same
 * plan; a solo COMPLAINT_CREATE has empty dependsOn and is gated by workflow
 * level / tool policy at execution time.
 */
export function planTasks(
  intents: ValidatedIntent[],
  facts: Record<string, unknown> = {},
): AgentTask[] {
  const ordered = [...intents].sort(
    (left, right) => INTENT_ORDER.indexOf(left.intent) - INTENT_ORDER.indexOf(right.intent),
  );

  const usedIds = new Set<string>();

  const tasks: AgentTask[] = ordered.map((intent) => {
    const definition = getIntentDefinition(intent.intent);
    const entities = applyFacts(intent.entities, facts);
    const required = definition?.requiredEntities ?? intent.missingEntities;

    return {
      taskId: taskIdFor(intent.intent, usedIds),
      intent: intent.intent,
      agent: intent.agent,
      domain: intent.domain,
      entities,
      dependsOn: [],
      missingEntities: required.filter((name) => entities[name] === undefined),
      confidence: intent.confidence,
    };
  });

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
