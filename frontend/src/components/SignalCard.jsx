import React, { useState } from 'react';

function SignalCard({ signal }) {
  const [showDetails, setShowDetails] = useState(false);
  const isTriggered = signal.status === 'TRIGGERED';
  const isExit = signal.status === 'EXIT' || signal.status === 'ABORTED';
  const scoreNum = parseInt(signal.confidence?.replace('%', '') || 0);
  const scoreClass = scoreNum >= 90 ? 'score-high' : scoreNum >= 70 ? 'score-medium' : 'score-low';

  return (
    <div className={`signal-card bg-gray-800 rounded-xl p-5 border ${isTriggered ? 'border-emerald-500 triggered-pulse' : 'border-gray-700'} ${isExit ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-bold">{signal.instrument}</h3>
          <span className={`badge-${signal.direction} px-3 py-1 rounded-full text-sm font-bold`}>
            {signal.action}
          </span>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-bold ${scoreClass}`}>{signal.confidence}</div>
          <div className="text-xs text-gray-400">Confidence</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="bg-gray-900 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">Entry</div>
          <div className="text-lg font-semibold text-emerald-400">{signal.entry}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">SL</div>
          <div className="text-lg font-semibold text-red-400">{signal.stop}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">Target</div>
          <div className="text-lg font-semibold text-emerald-400">{signal.target}</div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-400">Status: <span className="text-white font-medium">{signal.status}</span></span>
          <span className="text-gray-400">Triggered: <span className="text-white">{signal.triggeredAt}</span></span>
        </div>
        <div className="flex items-center gap-3">
          <span className="bg-gray-700 px-3 py-1 rounded text-sm">{signal.reason}</span>
          {signal.details && (
            <button onClick={() => setShowDetails(!showDetails)} className="text-emerald-400 text-sm hover:text-emerald-300 transition">
              {showDetails ? 'View Less ▲' : 'View Details ▼'}
            </button>
          )}
        </div>
      </div>

      {showDetails && signal.details && (
        <div className="mt-4 bg-gray-900 rounded-lg p-4 text-sm">
          <h4 className="font-bold text-gray-300 mb-3">Signal Details</h4>
          <div className="grid grid-cols-2 gap-4">
            {signal.details.trendAnalysis && (
              <div><div className="text-gray-400 mb-1">Trend Score</div><div className="text-white">{signal.details.trendAnalysis.trendScore || 'N/A'}/100</div></div>
            )}
            {signal.details.oiAnalysis && (
              <div><div className="text-gray-400 mb-1">OI Pattern</div><div className="text-white">{signal.details.oiAnalysis.oiPattern || 'N/A'}</div></div>
            )}
            {signal.details.volumeAnalysis && (
              <div><div className="text-gray-400 mb-1">Volume Strength</div><div className="text-white">{signal.details.volumeAnalysis.volumeStrength || 'N/A'}/100</div></div>
            )}
            {signal.details.regimeAnalysis && (
              <div><div className="text-gray-400 mb-1">Regime</div><div className="text-white">{signal.details.regimeAnalysis.regime || 'N/A'} ({Math.round((signal.details.regimeAnalysis.regimeConfidence || 0) * 100)}%)</div></div>
            )}
          </div>
          {signal.details.gateResults && (
            <div className="mt-3">
              <div className="text-gray-400 mb-2">Gate Results</div>
              <div className="space-y-1">
                {signal.details.gateResults.map((g, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className={g.pass ? 'text-emerald-400' : 'text-red-400'}>{g.pass ? '✓' : '✗'}</span>
                    <span className="text-gray-300">Gate {g.gate}: {g.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SignalCard;
