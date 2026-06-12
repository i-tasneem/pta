// scanner/OIScanner.js
class OIScanner {
  constructor(instrument, eventBus, redisSchema) {
    this.instrument = instrument;
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.oiHistory = []; // Last 20 snapshots
    this.pcrHistory = [];
    this.wallHistory = { support: [], resistance: [] };
  }

  async onOIUpdate(chainData) {
    const now = Date.now();

    // Add to history
    this.oiHistory.push({
      timestamp: now,
      totalCeOi: chainData.totalCeOi || 0,
      totalPeOi: chainData.totalPeOi || 0,
      pcr: chainData.pcr || 0,
      atmStrike: chainData.atmStrike || 0,
      strikes: chainData.strikes || []
    });

    if (this.oiHistory.length > 20) this.oiHistory.shift();
    this.pcrHistory.push(chainData.pcr || 0);
    if (this.pcrHistory.length > 20) this.pcrHistory.shift();

    // Calculate OI Velocity (contracts per minute)
    const velocity = this.calculateOIVelocity();

    // Calculate OI Acceleration
    const acceleration = this.calculateOIAcceleration();

    // Identify walls
    const supportWalls = this.identifySupportWalls(chainData);
    const resistanceWalls = this.identifyResistanceWalls(chainData);

    // Detect wall migration
    const wallMigration = this.detectWallMigration(supportWalls, resistanceWalls);

    // Detect wall break
    const wallBreak = this.detectWallBreak(chainData, supportWalls, resistanceWalls);

    // Detect OI patterns
    const oiPattern = this.detectOIPattern();

    // PCR trend
    const pcrTrend = this.detectPCRTrend();

    // Strike concentration
    const concentration = this.calculateStrikeConcentration(chainData);

    // Max pain
    const maxPain = this.calculateMaxPain(chainData);

    // Write to market_state
    await this.eventBus.hset(this.schema.marketState(this.instrument), {
      oiVelocity: velocity.toFixed(2),
      oiAcceleration: acceleration.toFixed(2),
      oiPattern,
      pcrTrend,
      pcrValue: (chainData.pcr || 0).toFixed(3),
      supportWalls: JSON.stringify(supportWalls),
      resistanceWalls: JSON.stringify(resistanceWalls),
      wallMigration: wallMigration ? JSON.stringify(wallMigration) : 'null',
      wallBreak: wallBreak ? JSON.stringify(wallBreak) : 'null',
      strikeConcentration: concentration.toFixed(2),
      totalCeOi: chainData.totalCeOi || 0,
      totalPeOi: chainData.totalPeOi || 0,
      atmStrike: chainData.atmStrike || 0,
      maxPain,
      spotLtp: chainData.spotLtp || 0
    });

    // Write to OI history stream
    await this.eventBus.xadd(this.schema.oiHistory(this.instrument), '*', {
      totalCeOi: chainData.totalCeOi || 0,
      totalPeOi: chainData.totalPeOi || 0,
      pcr: chainData.pcr || 0,
      supportWalls: JSON.stringify(supportWalls),
      resistanceWalls: JSON.stringify(resistanceWalls),
      timestamp: now
    });

    await this.eventBus.xtrim(this.schema.oiHistory(this.instrument), 'MAXLEN', 1000);

    // Emit events
    await this.eventBus.publish('oi:velocity', this.instrument, {
      velocity, acceleration, pattern: oiPattern, pcrTrend
    });

    if (wallMigration) {
      await this.eventBus.publish('wall:migration', this.instrument, wallMigration);
    }

    if (wallBreak) {
      await this.eventBus.publish('wall:break', this.instrument, wallBreak);
    }
  }

  calculateOIVelocity() {
    if (this.oiHistory.length < 2) return 0;
    const latest = this.oiHistory[this.oiHistory.length - 1];
    const previous = this.oiHistory[this.oiHistory.length - 2];
    const timeDiff = (latest.timestamp - previous.timestamp) / 60000; // minutes
    if (timeDiff <= 0) return 0;
    const totalOiLatest = latest.totalCeOi + latest.totalPeOi;
    const totalOiPrev = previous.totalCeOi + previous.totalPeOi;
    return (totalOiLatest - totalOiPrev) / timeDiff;
  }

  calculateOIAcceleration() {
    if (this.oiHistory.length < 3) return 0;
    const v1 = this.calculateOIVelocityAt(this.oiHistory.length - 2);
    const v2 = this.calculateOIVelocityAt(this.oiHistory.length - 1);
    const timeDiff = (this.oiHistory[this.oiHistory.length - 1].timestamp -
                      this.oiHistory[this.oiHistory.length - 2].timestamp) / 60000;
    return timeDiff > 0 ? (v2 - v1) / timeDiff : 0;
  }

  calculateOIVelocityAt(index) {
    if (index < 1) return 0;
    const curr = this.oiHistory[index];
    const prev = this.oiHistory[index - 1];
    const timeDiff = (curr.timestamp - prev.timestamp) / 60000;
    if (timeDiff <= 0) return 0;
    const totalOiCurr = curr.totalCeOi + curr.totalPeOi;
    const totalOiPrev = prev.totalCeOi + prev.totalPeOi;
    return (totalOiCurr - totalOiPrev) / timeDiff;
  }

  identifySupportWalls(chainData) {
    const strikes = chainData.strikes || [];
    const atmStrike = chainData.atmStrike || 0;
    const peStrikes = strikes.filter(s => s.strike < atmStrike);
    peStrikes.sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0));
    const totalPeOi = chainData.totalPeOi || 1;

    return peStrikes.slice(0, 3).map(s => ({
      strike: s.strike,
      oi: s.pe?.oi || 0,
      strength: ((s.pe?.oi || 0) / totalPeOi).toFixed(4)
    }));
  }

  identifyResistanceWalls(chainData) {
    const strikes = chainData.strikes || [];
    const atmStrike = chainData.atmStrike || 0;
    const ceStrikes = strikes.filter(s => s.strike > atmStrike);
    ceStrikes.sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0));
    const totalCeOi = chainData.totalCeOi || 1;

    return ceStrikes.slice(0, 3).map(s => ({
      strike: s.strike,
      oi: s.ce?.oi || 0,
      strength: ((s.ce?.oi || 0) / totalCeOi).toFixed(4)
    }));
  }

  detectWallMigration(currentSupport, currentResistance) {
    if (this.wallHistory.support.length === 0) {
      this.wallHistory.support = currentSupport;
      this.wallHistory.resistance = currentResistance;
      return null;
    }

    const prevSupport = this.wallHistory.support;
    const prevResistance = this.wallHistory.resistance;

    const supportShift = prevSupport[0]?.strike !== currentSupport[0]?.strike;
    const resistanceShift = prevResistance[0]?.strike !== currentResistance[0]?.strike;

    this.wallHistory.support = currentSupport;
    this.wallHistory.resistance = currentResistance;

    if (supportShift || resistanceShift) {
      return {
        type: supportShift && resistanceShift ? 'BOTH' :
              supportShift ? 'SUPPORT' : 'RESISTANCE',
        from: { support: prevSupport, resistance: prevResistance },
        to: { support: currentSupport, resistance: currentResistance },
        direction: this.inferWallDirection(prevSupport, currentSupport, prevResistance, currentResistance)
      };
    }
    return null;
  }

  inferWallDirection(prevSupport, currSupport, prevResistance, currResistance) {
    const supportUp = (currSupport[0]?.strike || 0) > (prevSupport[0]?.strike || 0);
    const resistanceUp = (currResistance[0]?.strike || 0) > (prevResistance[0]?.strike || 0);
    if (supportUp && resistanceUp) return 'UP';
    if (!supportUp && !resistanceUp) return 'DOWN';
    return 'MIXED';
  }

  detectWallBreak(chainData, supportWalls, resistanceWalls) {
    const spotLtp = chainData.spotLtp || 0;
    if (!spotLtp) return null;

    const nearestResistance = resistanceWalls[0];
    const nearestSupport = supportWalls[0];

    if (nearestResistance && spotLtp > nearestResistance.strike) {
      return { direction: 'CE', wall: nearestResistance, type: 'RESISTANCE_BREAK' };
    }

    if (nearestSupport && spotLtp < nearestSupport.strike) {
      return { direction: 'PE', wall: nearestSupport, type: 'SUPPORT_BREAK' };
    }

    return null;
  }

  detectOIPattern() {
    if (this.oiHistory.length < 2) return 'NEUTRAL';
    const curr = this.oiHistory[this.oiHistory.length - 1];
    const prev = this.oiHistory[this.oiHistory.length - 2];

    // We need price data to determine pattern - simplified version
    const oiChange = (curr.totalCeOi + curr.totalPeOi) - (prev.totalCeOi + prev.totalPeOi);
    if (oiChange > 0) return 'FRESH_BUILDUP';
    if (oiChange < 0) return 'UNWINDING';
    return 'NEUTRAL';
  }

  detectPCRTrend() {
    if (this.pcrHistory.length < 5) return 'NEUTRAL';
    const recent = this.pcrHistory.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const diff = last - first;

    if (diff > 0.05) return 'RISING';
    if (diff < -0.05) return 'FALLING';
    return 'FLAT';
  }

  calculateMaxPain(chainData) {
    const strikes = chainData.strikes || [];
    if (strikes.length === 0) return 0;

    let maxPainStrike = 0;
    let minPain = Infinity;

    for (const candidate of strikes) {
      let pain = 0;
      for (const s of strikes) {
        pain += (s.ce?.oi || 0) * Math.max(0, candidate.strike - s.strike);
        pain += (s.pe?.oi || 0) * Math.max(0, s.strike - candidate.strike);
      }
      if (pain < minPain) {
        minPain = pain;
        maxPainStrike = candidate.strike;
      }
    }

    return maxPainStrike;
  }

  calculateStrikeConcentration(chainData) {
    const strikes = chainData.strikes || [];
    if (strikes.length === 0) return 0;

    const totalOi = (chainData.totalCeOi || 0) + (chainData.totalPeOi || 0);
    if (totalOi === 0) return 0;

    const top3Oi = strikes
      .map(s => (s.ce?.oi || 0) + (s.pe?.oi || 0))
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((a, b) => a + b, 0);

    return (top3Oi / totalOi) * 100;
  }
}

module.exports = OIScanner;
