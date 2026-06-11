import React from 'react';

function RegimeMonitor({ regimes }) {
  if (regimes.length === 0) return null;
  return (
    <div className="flex gap-2">
      {regimes.slice(0, 3).map(r => (
        <div key={r.instrument} className={`regime-${r.regime} px-2 py-1 rounded text-xs font-medium`}>
          {r.instrument}: {r.regime}
        </div>
      ))}
    </div>
  );
}

export default RegimeMonitor;
