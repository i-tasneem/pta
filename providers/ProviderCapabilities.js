// A provider must advertise data semantics before it can be selected. This
// prevents a free delayed feed from being substituted for executable quotes.
const CAPABILITIES = new Set([
  'INSTRUMENTS', 'TICKS', 'TRADES', 'ORDER_BOOK', 'CANDLES',
  'OPTION_CHAIN', 'OPEN_INTEREST', 'FUNDING', 'SETTLEMENTS', 'HISTORICAL'
]);

class ProviderCapabilities {
  constructor(input = {}) {
    this.provider = String(input.provider || '').trim();
    if (!this.provider) throw new Error('provider name is required');
    this.assetClasses = new Set((input.assetClasses || []).map((x) => String(x).toUpperCase()));
    this.capabilities = new Set((input.capabilities || []).map((x) => String(x).toUpperCase()));
    for (const c of this.capabilities) if (!CAPABILITIES.has(c)) throw new Error(`unsupported capability: ${c}`);
    this.realtime = !!input.realtime;
    this.executionGrade = !!input.executionGrade;
    this.maxDelayMs = Number(input.maxDelayMs) || 0;
    this.history = Object.freeze({ ...(input.history || {}) });
    this.rateLimits = Object.freeze({ ...(input.rateLimits || {}) });
  }

  supports(assetClass, ...required) {
    return this.assetClasses.has(String(assetClass).toUpperCase()) &&
      required.every((c) => this.capabilities.has(String(c).toUpperCase()));
  }

  assertUsableForEntry(assetClass, ...required) {
    if (!this.supports(assetClass, ...required)) throw new Error(`${this.provider} lacks required market-data capabilities`);
    if (!this.realtime || !this.executionGrade || this.maxDelayMs > 1000) {
      throw new Error(`${this.provider} is not approved for executable entry decisions`);
    }
    return true;
  }
}

module.exports = { ProviderCapabilities, CAPABILITIES };
