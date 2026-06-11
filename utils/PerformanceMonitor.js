// utils/PerformanceMonitor.js
class PerformanceMonitor {
  constructor() {
    this.metrics = new Map();
    this.histograms = new Map();
  }

  startTimer(label) {
    return { label, startTime: process.hrtime.bigint() };
  }

  endTimer(timer) {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - timer.startTime) / 1_000_000;
    this.record(timer.label, durationMs);
    return durationMs;
  }

  record(label, value) {
    if (!this.metrics.has(label)) {
      this.metrics.set(label, { count: 0, sum: 0, min: Infinity, max: -Infinity, last: 0 });
    }
    const m = this.metrics.get(label);
    m.count++;
    m.sum += value;
    m.min = Math.min(m.min, value);
    m.max = Math.max(m.max, value);
    m.last = value;
  }

  getStats(label) {
    const m = this.metrics.get(label);
    if (!m) return null;
    return {
      label,
      count: m.count,
      avg: m.sum / m.count,
      min: m.min,
      max: m.max,
      last: m.last,
      p95: this.getPercentile(label, 0.95)
    };
  }

  getPercentile(label, p) {
    // Simplified percentile calculation
    const h = this.histograms.get(label);
    if (!h || h.length === 0) return 0;
    const sorted = [...h].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[idx];
  }

  getAllStats() {
    const result = {};
    for (const [label] of this.metrics) {
      result[label] = this.getStats(label);
    }
    return result;
  }

  reset() {
    this.metrics.clear();
    this.histograms.clear();
  }
}

module.exports = PerformanceMonitor;
