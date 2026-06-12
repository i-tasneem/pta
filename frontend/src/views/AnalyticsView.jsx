import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, SectionTitle, Empty, ScoreBar } from '../components/ui';
import { Sparkline, DualLine, VolumeBars } from '../components/charts';
import { fmtOI, fmtPrice } from '../lib/format';

// OI analytics, PCR trends, volume trends, support/resistance walls.
export default function AnalyticsView({ instruments, selected, onSelect }) {
  const [oiHistory, setOiHistory] = useState([]);
  const [volumes, setVolumes] = useState([]);
  const [loading, setLoading] = useState(false);

  const card = instruments.find(i => i.instrument === selected);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const [oi, vol] = await Promise.all([
          api.oiHistory(selected, 200),
          api.volume(selected, '5m', 50)
        ]);
        if (!cancelled) {
          setOiHistory(oi.history || []);
          setVolumes(vol.volumes || []);
        }
      } catch {
        if (!cancelled) { setOiHistory([]); setVolumes([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selected]);

  const pcrSeries = oiHistory.map(h => h.pcr).filter(v => v > 0);
  const ceSeries = oiHistory.map(h => h.totalCeOi);
  const peSeries = oiHistory.map(h => h.totalPeOi);

  return (
    <div>
      {/* Instrument selector */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {instruments.map(i => (
          <button key={i.instrument} onClick={() => onSelect(i.instrument)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
              selected === i.instrument
                ? 'bg-sky-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
            {i.instrument}
          </button>
        ))}
      </div>

      {!selected ? (
        <Empty title="Select an instrument" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* PCR Trend */}
          <Card>
            <SectionTitle sub="Put-Call Ratio over time — rising = put writing (bullish), falling = call writing (bearish)">
              PCR Trend
            </SectionTitle>
            {pcrSeries.length >= 2 ? (
              <>
                <div className="text-2xl font-bold text-slate-100 mb-2">
                  {pcrSeries[pcrSeries.length - 1].toFixed(3)}
                </div>
                <Sparkline data={pcrSeries} stroke="#38bdf8" height={64} />
              </>
            ) : <Empty title="No PCR history yet" hint={loading ? 'Loading…' : 'Builds up while OI feed is live'} />}
          </Card>

          {/* OI Trend */}
          <Card>
            <SectionTitle sub="Total CE vs PE open interest — divergence shows directional positioning">
              OI Trend
            </SectionTitle>
            {ceSeries.length >= 2 ? (
              <>
                <div className="flex gap-4 text-xs mb-2">
                  <span className="text-rose-400">CE {fmtOI(ceSeries[ceSeries.length - 1])}</span>
                  <span className="text-emerald-400">PE {fmtOI(peSeries[peSeries.length - 1])}</span>
                </div>
                <DualLine a={ceSeries} b={peSeries} labelA="CE OI" labelB="PE OI" />
              </>
            ) : <Empty title="No OI history yet" hint={loading ? 'Loading…' : 'Builds up while OI feed is live'} />}
          </Card>

          {/* Volume Trend */}
          <Card>
            <SectionTitle sub="5-minute volume bars — spikes confirm moves">
              Volume Trend
            </SectionTitle>
            {volumes.length > 0 ? (
              <VolumeBars data={volumes.map(v => v.volume)} />
            ) : <Empty title="No volume data yet" hint={loading ? 'Loading…' : 'Builds up while candle feed is live'} />}
            {card && (
              <div className="mt-3">
                <ScoreBar score={card.volumeStrength} label="Current Volume Activity" />
              </div>
            )}
          </Card>

          {/* Support / Resistance walls */}
          <Card>
            <SectionTitle sub="Largest OI concentrations — price tends to respect these levels">
              Support / Resistance Walls
            </SectionTitle>
            {card && (card.supportWalls?.length > 0 || card.resistanceWalls?.length > 0) ? (
              <WallChart card={card} />
            ) : <Empty title="No wall data yet" />}
          </Card>

          {/* OI Heatmap-style strike ladder */}
          <Card className="lg:col-span-2">
            <SectionTitle sub="OI distribution across strikes around ATM">
              Strike OI Heatmap
            </SectionTitle>
            <StrikeHeatmap instrument={selected} />
          </Card>
        </div>
      )}
    </div>
  );
}

function WallChart({ card }) {
  const walls = [
    ...(card.resistanceWalls || []).map(w => ({ ...w, side: 'R' })),
    ...(card.supportWalls || []).map(w => ({ ...w, side: 'S' }))
  ].sort((a, b) => b.strike - a.strike);

  const maxOi = Math.max(...walls.map(w => w.oi), 1);

  return (
    <div className="space-y-1.5">
      {walls.map((w, i) => (
        <div key={`${w.side}-${w.strike}-${i}`} className="flex items-center gap-2 text-xs">
          <span className="w-16 text-right font-medium text-slate-300">{fmtPrice(w.strike)}</span>
          <div className="flex-1 h-4 bg-slate-800 rounded overflow-hidden">
            <div
              className={`h-full rounded ${w.side === 'R' ? 'bg-rose-500/60' : 'bg-emerald-500/60'}`}
              style={{ width: `${(w.oi / maxOi) * 100}%` }}
            />
          </div>
          <span className="w-16 text-slate-500">{fmtOI(w.oi)}</span>
        </div>
      ))}
      {card.spotLtp > 0 && (
        <div className="text-[11px] text-slate-500 pt-1">Spot: {fmtPrice(card.ltp)}</div>
      )}
    </div>
  );
}

function StrikeHeatmap({ instrument }) {
  const [chain, setChain] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.chain(instrument)
      .then(d => { if (!cancelled) setChain(d); })
      .catch(() => { if (!cancelled) setChain(null); });
    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [instrument]);

  if (!chain || chain.strikes.length === 0) {
    return <Empty title="No option chain data yet" hint="Populates while the OI feed is live" />;
  }

  // Window of strikes around ATM
  const atmIdx = chain.strikes.findIndex(s => s.strike >= chain.atmStrike);
  const start = Math.max(0, atmIdx - 8);
  const window = chain.strikes.slice(start, start + 17);
  const maxOi = Math.max(...window.map(s => Math.max(s.ce?.oi || 0, s.pe?.oi || 0)), 1);

  return (
    <div className="space-y-1">
      <div className="flex items-center text-[10px] uppercase tracking-wider text-slate-500 gap-2">
        <span className="flex-1 text-right">Call OI</span>
        <span className="w-16 text-center">Strike</span>
        <span className="flex-1">Put OI</span>
      </div>
      {window.map(s => {
        const isATM = s.strike === chain.atmStrike;
        const isMaxPain = s.strike === chain.maxPain;
        return (
          <div key={s.strike} className={`flex items-center gap-2 text-xs rounded ${isATM ? 'bg-sky-500/10' : ''}`}>
            <div className="flex-1 flex justify-end">
              <div className="h-3.5 bg-rose-500/60 rounded-l"
                style={{ width: `${((s.ce?.oi || 0) / maxOi) * 100}%` }} />
            </div>
            <span className={`w-16 text-center font-medium ${
              isATM ? 'text-sky-300' : isMaxPain ? 'text-amber-300' : 'text-slate-400'}`}>
              {fmtPrice(s.strike)}{isMaxPain ? ' ◆' : ''}
            </span>
            <div className="flex-1">
              <div className="h-3.5 bg-emerald-500/60 rounded-r"
                style={{ width: `${((s.pe?.oi || 0) / maxOi) * 100}%` }} />
            </div>
          </div>
        );
      })}
      <div className="flex gap-4 pt-1 text-[11px] text-slate-500">
        <span><span className="text-sky-300">█</span> ATM {fmtPrice(chain.atmStrike)}</span>
        {chain.maxPain > 0 && <span><span className="text-amber-300">◆</span> Max Pain {fmtPrice(chain.maxPain)}</span>}
      </div>
    </div>
  );
}
