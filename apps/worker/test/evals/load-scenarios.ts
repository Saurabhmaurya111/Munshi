import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evalScenarioSchema,
  evalThresholdsSchema,
  type EvalScenario,
  type EvalThresholds,
} from "../../../../evals/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EVALS_ROOT = path.resolve(here, "../../../../evals");

export async function loadThresholds(): Promise<EvalThresholds> {
  const raw = await readFile(path.join(EVALS_ROOT, "thresholds.json"), "utf8");
  return evalThresholdsSchema.parse(JSON.parse(raw));
}

export async function loadScenarios(
  datasetVersion = "2026-10",
): Promise<EvalScenario[]> {
  const dir = path.join(EVALS_ROOT, "scenarios", `v${datasetVersion}`);
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith(".json")).sort();

  if (files.length === 0) {
    throw new Error(`no scenarios found in ${dir}`);
  }

  const scenarios: EvalScenario[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    const parsed = evalScenarioSchema.parse(JSON.parse(raw));

    if (parsed.version !== datasetVersion) {
      throw new Error(
        `scenario ${parsed.id} version ${parsed.version} does not match dataset ${datasetVersion}`,
      );
    }

    scenarios.push(parsed);
  }

  return scenarios;
}
