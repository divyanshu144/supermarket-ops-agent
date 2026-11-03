import { microUsd } from '../agent/limits.js';
import { recordUsage, type UsageTurnMetrics } from '../repositories/usage.js';

export type UsageWriter = (
  storeId: bigint,
  costMicroUsd: number,
  metrics: UsageTurnMetrics,
) => Promise<void>;

/** Calculate once and write the same integer cost into both operational sinks. */
export async function recordTurnCost(
  storeId: bigint,
  turnCostUsd: number,
  metrics: UsageTurnMetrics,
  onCost: (costMicroUsd: number) => void,
  writer: UsageWriter = recordUsage,
  prepaidCostMicroUsd = 0,
): Promise<number> {
  const modelCostMicroUsd = microUsd(turnCostUsd);
  const totalTurnCostMicroUsd = modelCostMicroUsd + Math.max(0, Math.round(prepaidCostMicroUsd));
  try {
    await writer(storeId, modelCostMicroUsd, metrics);
  } finally {
    onCost(totalTurnCostMicroUsd);
  }
  return totalTurnCostMicroUsd;
}
