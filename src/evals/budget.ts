/** Integer micro-USD admission ledger shared by synthetic and live coordinators. */
export class EvalBudget {
  readonly capMicroUsd: number;
  private spentMicroUsd = 0;
  private reservedMicroUsd = 0;

  constructor(capMicroUsd: number) {
    if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd < 0)
      throw new Error('Budget must be a non-negative safe integer in micro-USD');
    this.capMicroUsd = capMicroUsd;
  }

  reserve(maxMicroUsd: number): (actualMicroUsd?: number) => void {
    if (!Number.isSafeInteger(maxMicroUsd) || maxMicroUsd < 0)
      throw new Error('Reservation must be a non-negative safe integer in micro-USD');
    if (this.spentMicroUsd + this.reservedMicroUsd + maxMicroUsd > this.capMicroUsd)
      throw new Error('Eval budget exhausted');
    this.reservedMicroUsd += maxMicroUsd;
    let settled = false;
    return (actualMicroUsd?: number) => {
      if (settled) throw new Error('Budget reservation already settled');
      const charged = actualMicroUsd === undefined ? maxMicroUsd : actualMicroUsd;
      if (!Number.isSafeInteger(charged) || charged < 0 || charged > maxMicroUsd)
        throw new Error('Invalid reservation settlement');
      settled = true;
      this.reservedMicroUsd -= maxMicroUsd;
      this.spentMicroUsd += charged;
    };
  }

  snapshot() {
    return {
      capMicroUsd: this.capMicroUsd,
      spentMicroUsd: this.spentMicroUsd,
      reservedMicroUsd: this.reservedMicroUsd,
      remainingMicroUsd: this.capMicroUsd - this.spentMicroUsd - this.reservedMicroUsd,
    };
  }
}
