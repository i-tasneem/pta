import React from 'react';

function NotificationCenter({ notifications }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <h3 className="font-bold text-lg mb-4">Notifications</h3>
      {notifications.length === 0 && <div className="text-gray-500 text-sm text-center py-8">No notifications yet</div>}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {notifications.slice(0, 20).map((n, i) => (
          <div key={i} className={`p-3 rounded-lg text-sm ${n.type === 'trigger' ? 'bg-emerald-900/50 border border-emerald-700' : 'bg-gray-900'}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium">{n.instrument}</span>
              <span className="text-xs text-gray-400">{new Date(n.time).toLocaleTimeString()}</span>
            </div>
            <div className="text-gray-300 mt-1">{n.type === 'trigger' ? `Signal triggered: ${n.reason}` : n.type}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default NotificationCenter;
