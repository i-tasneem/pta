import React from 'react';

// Lightweight SVG charts — no charting library, scanner-grade visuals only.

function scale(values, height, pad = 4) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return v => height - pad - ((v - min) / range) * (height - pad * 2);
}

export function Sparkline({ data, width = 240, height = 48, stroke = '#34d399' }) {
  if (!data || data.length < 2) {
    return <div className="text-xs text-slate-600 h-12 flex items-center">Not enough data</div>;
  }
  const y = scale(data, height);
  const step = width / (data.length - 1);
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = data[data.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" />
      <circle cx={(data.length - 1) * step} cy={y(last)} r="2.5" fill={stroke} />
    </svg>
  );
}

// Two overlaid lines sharing a y-scale (e.g. CE OI vs PE OI)
export function DualLine({ a, b, width = 320, height = 96, colorA = '#f87171', colorB = '#34d399', labelA = 'CE', labelB = 'PE' }) {
  if (!a || a.length < 2 || !b || b.length < 2) {
    return <div className="text-xs text-slate-600 h-24 flex items-center">Not enough data</div>;
  }
  const y = scale([...a, ...b], height);
  const line = (data, n) => {
    const step = width / (n - 1);
    return data.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  };

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        <polyline points={line(a, a.length)} fill="none" stroke={colorA} strokeWidth="1.5" />
        <polyline points={line(b, b.length)} fill="none" stroke={colorB} strokeWidth="1.5" />
      </svg>
      <div className="flex gap-4 mt-1 text-[11px] text-slate-400">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: colorA }} /> {labelA}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ background: colorB }} /> {labelB}
        </span>
      </div>
    </div>
  );
}

export function VolumeBars({ data, width = 320, height = 80, color = '#38bdf8' }) {
  if (!data || data.length === 0) {
    return <div className="text-xs text-slate-600 h-20 flex items-center">Not enough data</div>;
  }
  const max = Math.max(...data) || 1;
  const barW = width / data.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
      {data.map((v, i) => {
        const h = (v / max) * (height - 4);
        return (
          <rect key={i} x={i * barW + 0.5} y={height - h} width={Math.max(barW - 1, 1)}
            height={h} fill={color} opacity={0.4 + 0.6 * (v / max)} rx="1" />
        );
      })}
    </svg>
  );
}
