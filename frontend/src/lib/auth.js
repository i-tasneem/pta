// Auth API client. Same-origin cookies carry the session automatically.
async function req(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  }
  return data;
}

export const auth = {
  status: () => req('/api/auth/status'),
  me: () => req('/api/auth/me'),
  login: (username, password) => req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  signup: (payload) => req('/api/auth/signup', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => req('/api/auth/logout', { method: 'POST' })
};
