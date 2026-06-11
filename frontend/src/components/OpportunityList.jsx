import React from 'react';

function OpportunityList({ opportunities }) {
  if (opportunities.length === 0) {
    return <div className="text-gray-500 text-center py-12">No opportunities detected</div>;
  }

  return (
    <div className="space-y-3">
      {opportunities.map((opp, index) => {
        const score = parseFloat(opp.score || 0);
        const scoreClass = score >= 90 ? 'text-emerald-400' : score >= 70 ? 'text-amber-400' : 'text-red-400';
        const bgClass = score >= 90 ? 'bg-emerald-900/30 border-emerald-700' : score >= 70 ? 'bg-amber-900/30 border-amber-700' : 'bg-gray-800 border-gray-700';

        return (
          <div key={opp.opportunityId || index} className={`${bgClass} border rounded-lg p-4 flex items-center justify-between`}>
            <div className="flex items-center gap-4">
              <div className="text-2xl font-bold w-12">#{index + 1}</div>
              <div>
                <div className="font-bold text-lg">{opp.instrument}</div>
                <div className="text-sm text-gray-400">{opp.direction} | {opp.regime} | {opp.state}</div>
              </div>
            </div>
            <div className="text-right">
              <div className={`text-3xl font-bold ${scoreClass}`}>{score.toFixed(0)}</div>
              <div className="text-xs text-gray-400">Score</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default OpportunityList;
