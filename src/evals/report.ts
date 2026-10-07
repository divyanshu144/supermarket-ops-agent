import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AttemptResult {
  scenarioId: string;
  repetition: number;
  pass: boolean;
  costMicroUsd: number | null;
  turns: number;
  toolCalls: number;
  wallMs: number;
  status: 'complete' | 'aborted' | 'invalid';
}

export function summarizeAttempts(attempts: AttemptResult[], plannedRepetitions: number) {
  if (!Number.isSafeInteger(plannedRepetitions) || plannedRepetitions < 1)
    throw new Error('planned repetitions must be a positive integer');
  const byScenario = new Map<string, AttemptResult[]>();
  for (const attempt of attempts) {
    const list = byScenario.get(attempt.scenarioId) ?? [];
    list.push(attempt);
    byScenario.set(attempt.scenarioId, list);
  }
  const first = [...byScenario.values()].filter((values) => values.some((v) => v.repetition === 1));
  const firstPass = first.filter((values) => values.find((v) => v.repetition === 1)?.pass).length;
  const allPass = first.filter(
    (values) =>
      values.length === plannedRepetitions &&
      values.every((value) => value.status === 'complete' && value.pass),
  ).length;
  const flaky = [...byScenario.entries()]
    .filter(([, values]) => values.some((v) => v.pass) && values.some((v) => !v.pass))
    .map(([id]) => id)
    .sort();
  return {
    provenance: 'synthetic' as const,
    plannedRepetitions,
    plannedScenarios: byScenario.size,
    completedAttempts: attempts.filter((a) => a.status === 'complete').length,
    passAt1: first.length === 0 ? null : firstPass / first.length,
    allNPassRate: first.length === 0 ? null : allPass / first.length,
    flakyScenarios: flaky,
    totalCostMicroUsd: attempts.reduce((sum, a) => sum + (a.costMicroUsd ?? 0), 0),
    costSemantics: 'unverified; synthetic cost fields are not provider cost evidence',
    attempts,
  };
}

export async function writeSyntheticReport(path: string, report: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
