// Canonical, provider-neutral identity for every tradable or observed market.
// Provider symbols belong in aliases; strategy/state keys use `id` only.
const ASSET_CLASSES = new Set(['EQUITY', 'INDEX', 'FOREX', 'CRYPTO', 'COMMODITY']);
const CONTRACT_TYPES = new Set(['SPOT', 'FUTURE', 'PERPETUAL', 'OPTION', 'INDEX']);

function required(value, name) {
  const s = String(value || '').trim();
  if (!s) throw new Error(`instrument ${name} is required`);
  return s;
}

function part(value) {
  return encodeURIComponent(required(value, 'id component'));
}

class InstrumentSpec {
  constructor(input) {
    input = input || {};
    this.assetClass = required(input.assetClass, 'assetClass').toUpperCase();
    this.venue = required(input.venue, 'venue').toUpperCase();
    this.symbol = required(input.symbol, 'symbol').toUpperCase();
    this.contractType = required(input.contractType, 'contractType').toUpperCase();
    this.quoteCurrency = required(input.quoteCurrency, 'quoteCurrency').toUpperCase();
    this.baseCurrency = input.baseCurrency ? String(input.baseCurrency).toUpperCase() : null;
    this.expiry = input.expiry || null;
    this.strike = input.strike == null ? null : Number(input.strike);
    this.optionRight = input.optionRight ? String(input.optionRight).toUpperCase() : null;
    this.multiplier = input.multiplier == null ? 1 : Number(input.multiplier);
    this.tickSize = input.tickSize == null ? null : Number(input.tickSize);
    this.aliases = Object.freeze({ ...(input.aliases || {}) });

    if (!ASSET_CLASSES.has(this.assetClass)) throw new Error(`unsupported assetClass: ${this.assetClass}`);
    if (!CONTRACT_TYPES.has(this.contractType)) throw new Error(`unsupported contractType: ${this.contractType}`);
    if (this.contractType === 'FUTURE' && !this.expiry) throw new Error('future expiry is required');
    if (this.contractType === 'OPTION' && (!this.expiry || !(this.strike > 0) || !['CALL', 'PUT'].includes(this.optionRight))) {
      throw new Error('option expiry, positive strike, and CALL/PUT right are required');
    }
    if (!(this.multiplier > 0)) throw new Error('instrument multiplier must be positive');

    const contract = this.contractType === 'OPTION'
      ? `${this.expiry}:${this.strike}:${this.optionRight}`
      : this.contractType === 'FUTURE' ? this.expiry : this.contractType;
    this.id = `${part(this.assetClass)}:${part(this.venue)}:${part(this.symbol)}:${part(contract)}`;
    Object.freeze(this);
  }
}

module.exports = { InstrumentSpec, ASSET_CLASSES, CONTRACT_TYPES };
