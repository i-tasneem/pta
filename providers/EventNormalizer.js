// providers/EventNormalizer.js
class EventNormalizer {
  constructor(redisSchema, eventBus) {
    this.schema = redisSchema;
    this.eventBus = eventBus;
  }

  // Normalize Dhan tick to unified format
  normalizeTick(rawTick) {
    const num = v => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      instrument: rawTick.tradingSymbol || rawTick.securityId,
      securityId: rawTick.securityId,
      ltp: num(rawTick.lastPrice ?? rawTick.ltp),
      bid: num(rawTick.bid ?? rawTick.bidPrice),
      ask: num(rawTick.ask ?? rawTick.askPrice),
      volume: Math.trunc(num(rawTick.volume ?? rawTick.totalTradedQty)),
      oi: Math.trunc(num(rawTick.oi ?? rawTick.openInterest)),
      change: num(rawTick.change),
      changePercent: num(rawTick.changePercent),
      vwap: num(rawTick.vwap),
      high: num(rawTick.dayHigh ?? rawTick.high),
      low: num(rawTick.dayLow ?? rawTick.low),
      open: num(rawTick.dayOpen ?? rawTick.open),
      prevClose: num(rawTick.prevClose ?? rawTick.previousClose),
      timestamp: Date.now()
    };
  }

  // Normalize Dhan option chain to unified format
  normalizeOptionChain(rawChain, instrument) {
    const strikes = [];
    let totalCeOi = 0;
    let totalPeOi = 0;
    let atmStrike = 0;
    let minDiff = Infinity;

    const spotLtp = rawChain.underlyingPrice || rawChain.spotPrice || 0;

    for (const item of rawChain.data || []) {
      const strike = parseFloat(item.strikePrice);
      const diff = Math.abs(strike - spotLtp);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = strike;
      }

      const ce = item.CE || {};
      const pe = item.PE || {};

      totalCeOi += parseInt(ce.openInterest || 0, 10);
      totalPeOi += parseInt(pe.openInterest || 0, 10);

      strikes.push({
        strike,
        ce: {
          ltp: parseFloat(ce.lastPrice || 0),
          bid: parseFloat(ce.bidPrice || 0),
          ask: parseFloat(ce.askPrice || 0),
          volume: parseInt(ce.totalTradedVolume || 0, 10),
          oi: parseInt(ce.openInterest || 0, 10),
          change: parseFloat(ce.change || 0),
          iv: parseFloat(ce.impliedVolatility || 0),
          delta: parseFloat(ce.delta || 0)
        },
        pe: {
          ltp: parseFloat(pe.lastPrice || 0),
          bid: parseFloat(pe.bidPrice || 0),
          ask: parseFloat(pe.askPrice || 0),
          volume: parseInt(pe.totalTradedVolume || 0, 10),
          oi: parseInt(pe.openInterest || 0, 10),
          change: parseFloat(pe.change || 0),
          iv: parseFloat(pe.impliedVolatility || 0),
          delta: parseFloat(pe.delta || 0)
        }
      });
    }

    const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : 0;

    return {
      instrument,
      spotLtp,
      atmStrike,
      strikes,
      pcr,
      totalCeOi,
      totalPeOi,
      expiry: rawChain.expiryDate || '',
      timestamp: Date.now()
    };
  }

  // Write normalized tick to Redis
  async writeTick(tick) {
    const key = this.schema.tick(tick.instrument);
    await this.eventBus.hset(key, {
      ltp: tick.ltp,
      bid: tick.bid,
      ask: tick.ask,
      volume: tick.volume,
      oi: tick.oi,
      change: tick.change,
      changePercent: tick.changePercent,
      vwap: tick.vwap,
      high: tick.high,
      low: tick.low,
      open: tick.open,
      prevClose: tick.prevClose,
      timestamp: tick.timestamp
    });
    await this.eventBus.expire(key, 10);

    // Publish event
    await this.eventBus.publish('tick:update', tick.instrument, tick);
  }

  // Write normalized option chain to Redis
  async writeOptionChain(chain) {
    // Keyed without expiry: readers (gateway, opportunity engine) look up
    // optionChain(instrument); the expiry is stored as a field
    const key = this.schema.optionChain(chain.instrument);
    const fields = {
      atmStrike: chain.atmStrike,
      pcr: chain.pcr,
      totalCeOi: chain.totalCeOi,
      totalPeOi: chain.totalPeOi,
      spotLtp: chain.spotLtp,
      expiry: chain.expiry,
      timestamp: chain.timestamp
    };

    for (const s of chain.strikes) {
      fields[`ce:${s.strike}`] = JSON.stringify(s.ce);
      fields[`pe:${s.strike}`] = JSON.stringify(s.pe);
    }

    await this.eventBus.hset(key, fields);
    await this.eventBus.expire(key, 30);

    // Publish event
    await this.eventBus.publish('oi:update', chain.instrument, chain);
  }
}

module.exports = EventNormalizer;
