// Fixed-capacity rolling window for online normalization.
// Note: this is a recent-sample baseline. The same-time-of-day, multi-day
// baseline (the stronger normalization) is a later refinement that needs
// persisted history — this is its in-session approximation.
export class RollingWindow {
  private buf: number[] = [];

  constructor(private capacity: number) {}

  push(x: number): void {
    this.buf.push(x);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  get size(): number {
    return this.buf.length;
  }

  mean(): number {
    if (this.buf.length === 0) return 0;
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }

  std(): number {
    const n = this.buf.length;
    if (n < 2) return 0;
    const m = this.mean();
    const variance = this.buf.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
    return Math.sqrt(variance);
  }

  zscore(x: number): number {
    const s = this.std();
    if (s === 0) return 0;
    return (x - this.mean()) / s;
  }

  // Fraction of samples <= x, in [0,1]
  percentileRank(x: number): number {
    if (this.buf.length === 0) return 0.5;
    const count = this.buf.filter((v) => v <= x).length;
    return count / this.buf.length;
  }
}
