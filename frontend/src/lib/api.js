// Thin API client for the PTA backend

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const api = {
  screener: () => get('/api/screener'),
  activeSignals: (details = true) => get(`/api/signals/active?details=${details}`),
  signalHistory: (instrument, limit = 100) =>
    get(`/api/signals/history?limit=${limit}${instrument ? `&instrument=${instrument}` : ''}`),
  oiHistory: (instrument, limit = 200) => get(`/api/oi/${instrument}/history?limit=${limit}`),
  volume: (instrument, tf = '5m', limit = 50) => get(`/api/volume/${instrument}?tf=${tf}&limit=${limit}`),
  chain: (instrument) => get(`/api/chain/${instrument}`),
  performance: () => get('/api/performance'),
  opportunities: (limit = 10) => get(`/api/opportunities?limit=${limit}`),
  v2Setups: () => get('/api/v2/setups'),
  v2Signals: (limit = 100, shadow = false) => get(`/api/v2/signals?limit=${limit}${shadow ? '&shadow=1' : ''}`),
  universe: () => get('/api/universe')
};
