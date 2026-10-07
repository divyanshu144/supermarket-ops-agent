import { z } from 'zod';
import { newToolContext, toolContext } from '../tools/context.js';
import type { DatabaseTarget } from './database.js';

const jsonValue: z.ZodType = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const replayStepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    tool: z.string().min(1),
    args: jsonValue,
    expect: z.record(z.string(), jsonValue).default({}),
  })
  .strict();

export const ReplayRecordingSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    provenance: z.literal('synthetic'),
    storeId: z.string().regex(/^[1-9][0-9]*$/),
    updateId: z.string().regex(/^[1-9][0-9]*$/),
    ownerUserId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    steps: z.array(replayStepSchema).min(1),
  })
  .strict()
  .superRefine((recording, ctx) => {
    const ids = new Set<string>();
    recording.steps.forEach((step, index) => {
      if (ids.has(step.id))
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: 'duplicate step id',
        });
      ids.add(step.id);
    });
  });

export type ReplayRecording = z.infer<typeof ReplayRecordingSchema>;
export interface ReplayTool {
  name: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (input: unknown, extra: unknown) => Promise<unknown>;
}
export interface ReplayResult {
  recordingId: string;
  calls: Array<{ id: string; tool: string; args: unknown; result: unknown }>;
}

export interface ReplayDatabaseTargets {
  process: DatabaseTarget;
  pool: DatabaseTarget;
}

export function assertSameDatabaseTarget(actual: DatabaseTarget, expected: DatabaseTarget): void {
  if (
    actual.host !== expected.host ||
    actual.port !== expected.port ||
    actual.database !== expected.database ||
    actual.user !== expected.user
  ) {
    throw new Error('Replay database target mismatch');
  }
}

export function assertReplayDatabaseTargets(
  actual: ReplayDatabaseTargets,
  expected: DatabaseTarget,
): void {
  assertSameDatabaseTarget(actual.process, expected);
  assertSameDatabaseTarget(actual.pool, expected);
}

function resolve(value: unknown, results: Map<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$ref:')) {
    const [, stepId, ...path] = value.split(/[.:]/);
    if (!stepId || !results.has(stepId))
      throw new Error(`Unknown replay result reference: ${value}`);
    let current = results.get(stepId);
    for (const key of path) {
      if (current === null || typeof current !== 'object' || !(key in current))
        throw new Error(`Unresolved replay result path: ${value}`);
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, results));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolve(entry, results)]),
    );
  return value;
}

function assertExpected(actual: unknown, expected: Record<string, unknown>, path = 'result') {
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = (actual as Record<string, unknown> | null)?.[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (actualValue === null || typeof actualValue !== 'object')
        throw new Error(`${path}.${key}: expected object, received ${String(actualValue)}`);
      assertExpected(actualValue, value as Record<string, unknown>, `${path}.${key}`);
    } else if (JSON.stringify(actualValue) !== JSON.stringify(value)) {
      throw new Error(
        `${path}.${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(actualValue)}`,
      );
    }
  }
}

/** Runs handlers from the supplied registry, checking the active DB target before each call. */
export async function executeReplayWithTools(
  input: unknown,
  registeredTools: readonly ReplayTool[],
  expectedTarget: DatabaseTarget,
  verifyTarget: () => Promise<ReplayDatabaseTargets>,
  verifyOwnership: () => Promise<void> = async () => undefined,
): Promise<ReplayResult> {
  const recording = ReplayRecordingSchema.parse(input);
  const tools = new Map(registeredTools.map((tool) => [tool.name, tool]));
  const context = newToolContext(
    BigInt(recording.storeId),
    BigInt(recording.updateId),
    undefined,
    recording.ownerUserId === undefined ? undefined : BigInt(recording.ownerUserId),
  );
  const results = new Map<string, unknown>();
  const calls: ReplayResult['calls'] = [];

  await verifyOwnership();
  assertReplayDatabaseTargets(await verifyTarget(), expectedTarget);
  await toolContext.run(context, async () => {
    for (const step of recording.steps) {
      await verifyOwnership();
      assertReplayDatabaseTargets(await verifyTarget(), expectedTarget);
      const tool = tools.get(step.tool);
      if (!tool) throw new Error(`Unknown registered store tool: ${step.tool}`);
      const args = resolve(step.args, results);
      const parsed = z.object(tool.inputSchema).strict().parse(args);
      const result = await tool.handler(parsed, {});
      const text = (result as { content?: Array<{ type?: string; text?: string }> })?.content?.find(
        (entry) => entry.type === 'text',
      )?.text;
      let decoded: unknown = result;
      if (text) {
        try {
          decoded = JSON.parse(text);
        } catch {
          throw new Error(`Tool ${step.tool} returned non-JSON text during replay`);
        }
      }
      assertExpected(decoded, resolve(step.expect, results) as Record<string, unknown>);
      results.set(step.id, decoded);
      calls.push({ id: step.id, tool: step.tool, args, result: decoded });
    }
  });

  return { recordingId: recording.id, calls };
}
