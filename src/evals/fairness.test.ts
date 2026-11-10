import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  checkFairnessRelease,
  corpusSha256,
  FairnessCorpusSchema,
  FairnessReportSchema,
  sameOutcome,
  runFairnessEvaluation,
  summarizeLanguage,
  wilsonInterval,
} from './fairness.js';

async function loadCorpus() {
  const text = await readFile(new URL('../../evals/fairness/corpus.json', import.meta.url), 'utf8');
  return { text, value: FairnessCorpusSchema.parse(JSON.parse(text)) };
}

describe('fairness evaluation primitives', () => {
  it('validates the frozen synthetic corpus and has three repeats, 24 names, five intents', async () => {
    const { value } = await loadCorpus();
    expect(value.repeats).toBeGreaterThanOrEqual(3);
    expect(value.names).toHaveLength(24);
    expect(new Set(value.scenarios.map((scenario) => scenario.intent)).size).toBe(5);
    expect(value.scenarios.every((scenario) => scenario.human_reviewed === false)).toBe(true);
  });

  it('validates the committed NOT RUN report against the pinned corpus hash', async () => {
    const { text } = await loadCorpus();
    const report = FairnessReportSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../../evals/results/fairness-latest.json', import.meta.url),
          'utf8',
        ),
      ),
    );
    expect(report.status).toBe('NOT RUN');
    expect(report.corpusSha256).toBe(corpusSha256(text));
    expect(report.reason).toMatch(/native-speaker review/);
    expect(checkFairnessRelease(report, corpusSha256(text)).pass).toBe(false);
  });

  it('detects corpus edits through its SHA-256', async () => {
    const { text } = await loadCorpus();
    const pinned = (
      await readFile(new URL('../../evals/fairness/corpus.sha256', import.meta.url), 'utf8')
    ).trim();
    expect(corpusSha256(text)).toBe(pinned);
    expect(corpusSha256(text)).not.toBe(corpusSha256(text.replace('Aarav', 'Aarav2')));
  });

  it('compares the complete tool and numeric outcome signature', () => {
    const baseline = {
      tools: ['charge_khata'],
      numericValues: [
        { path: 'amount', value: 10000 },
        { path: 'balance', value: 10000 },
      ],
      confirmation: false,
      state: { balancePaise: 10000 },
    };
    expect(sameOutcome(baseline, structuredClone(baseline))).toBe(true);
    expect(sameOutcome(baseline, { ...baseline, state: { balancePaise: 20000 } })).toBe(false);
    expect(sameOutcome(baseline, { ...baseline, confirmation: true })).toBe(false);
  });

  it('calculates a bounded Wilson interval and reports language differences', () => {
    const interval = wilsonInterval(9, 10);
    expect(interval.estimate).toBe(0.9);
    expect(interval.lower).toBeGreaterThan(0.5);
    expect(interval.upper).toBeLessThan(1);
    const summary = summarizeLanguage([
      ...Array.from({ length: 9 }, (_, i) => ({
        scenarioId: `en-${i}`,
        language: 'en' as const,
        pass: true,
        runId: `${i}`,
        toolSequence: [],
        costMicroUsd: 0,
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        scenarioId: `hi-${i}`,
        language: 'hi' as const,
        pass: i < 6,
        runId: `${i}`,
        toolSequence: [],
        costMicroUsd: 0,
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        scenarioId: `hinglish-${i}`,
        language: 'hinglish' as const,
        pass: true,
        runId: `${i}`,
        toolSequence: [],
        costMicroUsd: 0,
      })),
    ]);
    expect(summary.rates.hi.estimate).toBeCloseTo(2 / 3);
    expect(summary.intervals.hiVsEn.estimate).toBeCloseTo(-1 / 3);
  });

  it('fails release check for a stale or wrong-corpus report', async () => {
    const { text } = await loadCorpus();
    const okRate = { estimate: 1, lower: 0.8, upper: 1, successes: 30, total: 30, scenarios: 5 };
    const report = {
      version: 1,
      status: 'complete',
      createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      corpusSha256: corpusSha256(text),
      observations: [],
      nameInvariant: {
        successes: 1,
        total: 1,
        differences: [],
        interval: { estimate: 1, lower: 0.5, upper: 1, successes: 1, total: 1 },
      },
      language: {
        rates: { en: okRate, hi: okRate, hinglish: okRate },
        intervals: {
          hiVsEn: { estimate: 0, lower: -0.1, upper: 0.1 },
          hinglishVsEn: { estimate: 0, lower: -0.1, upper: 0.1 },
        },
      },
      repeatVariability: [],
      estimatedCostMicroUsd: 1,
      actualCostMicroUsd: 1,
      completedRuns: 1,
    };
    expect(checkFairnessRelease(report, corpusSha256(text)).failures).toContain('result-stale');
    expect(checkFairnessRelease(report, '0'.repeat(64)).failures).toContain('corpus-hash-mismatch');
    expect(() => checkFairnessRelease(undefined, corpusSha256(text))).toThrow();
    const belowThreshold = structuredClone(report);
    belowThreshold.createdAt = new Date().toISOString();
    belowThreshold.nameInvariant.successes = 0;
    belowThreshold.language.rates.hi.estimate = 0.7;
    belowThreshold.language.intervals.hiVsEn.estimate = -0.3;
    expect(checkFairnessRelease(belowThreshold, corpusSha256(text)).failures).toEqual(
      expect.arrayContaining([
        'name-invariance-threshold',
        'language-threshold-hi',
        'language-gap-hi',
      ]),
    );
  });

  it('the mocked runner detects a planted name difference and none when signatures are identical', async () => {
    const { value } = await loadCorpus();
    const firstScenario = value.scenarios[0]!;
    const run = async (different: boolean) =>
      runFairnessEvaluation({
        corpus: { ...value, scenarios: [firstScenario], repeats: 3 },
        corpusHash: 'a'.repeat(64),
        capMicroUsd: 100_000,
        estimatedRunMicroUsd: 1,
        runner: {
          async run(input) {
            const isPlanted = different && input.name === value.names[4]!.value;
            return {
              taskSuccess: true,
              costMicroUsd: 1,
              outcome: {
                tools: ['charge_khata'],
                numericValues: [{ path: 'amount', value: isPlanted ? 20000 : 10000 }],
                confirmation: false,
                state: { balancePaise: isPlanted ? 20000 : 10000 },
              },
            };
          },
        },
      });
    const planted = await run(true);
    const identical = await run(false);
    expect(planted.nameInvariant.differences.length).toBeGreaterThan(0);
    expect(identical.nameInvariant.differences).toEqual([]);
    expect(JSON.stringify(planted)).not.toContain('Aarav');
    expect(JSON.stringify(planted)).not.toContain('Aisha');
  });

  it('refuses an estimate over cap before making any provider call and checkpoints each run', async () => {
    const { value } = await loadCorpus();
    let calls = 0;
    const runner = {
      async run() {
        calls += 1;
        return {
          outcome: { tools: [], numericValues: [], confirmation: false, state: {} },
          taskSuccess: true,
          costMicroUsd: 1,
        };
      },
    };
    await expect(
      runFairnessEvaluation({
        corpus: value,
        corpusHash: 'a'.repeat(64),
        runner,
        capMicroUsd: 2,
        estimatedRunMicroUsd: 1,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(calls).toBe(0);
    const checkpoints: Array<{ completed: number; inProgress: string | null }> = [];
    await runFairnessEvaluation({
      corpus: {
        ...value,
        names: value.names.slice(0, 1),
        scenarios: value.scenarios.slice(0, 1),
        repeats: 3,
      },
      corpusHash: 'a'.repeat(64),
      runner,
      capMicroUsd: 100,
      estimatedRunMicroUsd: 1,
      saveCheckpoint: async (checkpoint) => {
        checkpoints.push({
          completed: checkpoint.completed.length,
          inProgress: checkpoint.inProgressRunId,
        });
      },
    });
    expect(checkpoints).toHaveLength(24);
    expect(checkpoints.filter((entry) => entry.inProgress !== null)).toHaveLength(12);
    expect(
      checkpoints.filter((entry) => entry.inProgress === null).map((entry) => entry.completed),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  it('resumes completed repetitions from a checkpoint without repeating paid attempts', async () => {
    const { value } = await loadCorpus();
    const corpus = {
      ...value,
      scenarios: value.scenarios.slice(0, 1),
      repeats: 3,
    };
    let calls = 0;
    let interrupted: import('./fairness.js').FairnessCheckpoint | undefined;
    let lastSafe: import('./fairness.js').FairnessCheckpoint | undefined;
    const runner = {
      async run() {
        calls += 1;
        if (calls === 4) throw new Error('simulated interruption');
        return {
          outcome: {
            tools: ['charge_khata'],
            numericValues: [{ path: 'amount', value: 10000 }],
            confirmation: false,
            state: { balancePaise: 10000 },
          },
          taskSuccess: true,
          costMicroUsd: 1,
        };
      },
    };
    await expect(
      runFairnessEvaluation({
        corpus,
        corpusHash: 'b'.repeat(64),
        runner,
        capMicroUsd: 100,
        estimatedRunMicroUsd: 1,
        saveCheckpoint: async (checkpoint) => {
          interrupted = structuredClone(checkpoint);
          if (checkpoint.completed.length === 3 && checkpoint.inProgressRunId === null)
            lastSafe = structuredClone(checkpoint);
        },
      }),
    ).rejects.toThrow('simulated interruption');
    expect(interrupted?.completed).toHaveLength(3);
    expect(interrupted?.inProgressRunId).toBe('name:khata-charge:name_02:1');
    expect(lastSafe?.completed).toHaveLength(3);
    let resumedCalls = 0;
    const report = await runFairnessEvaluation({
      corpus,
      corpusHash: 'b'.repeat(64),
      checkpoint: lastSafe,
      capMicroUsd: 100,
      estimatedRunMicroUsd: 1,
      runner: {
        async run() {
          resumedCalls += 1;
          return {
            outcome: {
              tools: ['charge_khata'],
              numericValues: [{ path: 'amount', value: 10000 }],
              confirmation: false,
              state: { balancePaise: 10000 },
            },
            taskSuccess: true,
            costMicroUsd: 1,
          };
        },
      },
    });
    expect(resumedCalls).toBe(78);
    expect(report.completedRuns).toBe(81);
    await expect(
      runFairnessEvaluation({
        corpus,
        corpusHash: 'b'.repeat(64),
        checkpoint: interrupted,
        capMicroUsd: 100,
        estimatedRunMicroUsd: 1,
        runner: {
          async run() {
            throw new Error('must not repeat an ambiguous paid attempt');
          },
        },
      }),
    ).rejects.toThrow(/unfinished paid attempt/);
  });
});
