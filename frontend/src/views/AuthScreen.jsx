import React, { useState } from 'react';
import { auth } from '../lib/auth';

function Field({ label, ...props }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        {...props}
        className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
      />
    </label>
  );
}

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [form, setForm] = useState({ username: '', password: '', name: '', email: '', phone: '', risk_profile: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setNotice(''); setBusy(true);
    try {
      if (mode === 'login') {
        const { user } = await auth.login(form.username, form.password);
        onAuthed(user);
      } else {
        const res = await auth.signup({
          username: form.username, name: form.name, email: form.email,
          phone: form.phone, risk_profile: form.risk_profile
        });
        setNotice(res.message || 'Request received. Your password will be provided shortly.');
        setMode('login');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-sky-400">PTA</h1>
          <p className="text-xs text-slate-500">Options Intelligence Screener</p>
        </div>

        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5">
          <div className="flex gap-1 mb-4">
            {['login', 'signup'].map((m) => (
              <button key={m} onClick={() => { setMode(m); setError(''); setNotice(''); }}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium capitalize transition ${
                  mode === m ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
                {m === 'login' ? 'Log in' : 'Request access'}
              </button>
            ))}
          </div>

          {notice && <div className="mb-3 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-2">{notice}</div>}
          {error && <div className="mb-3 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2">{error}</div>}

          <form onSubmit={submit} className="space-y-3">
            <Field label="Username" value={form.username} onChange={set('username')} autoComplete="username" required />

            {mode === 'login' ? (
              <Field label="Password" type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required />
            ) : (
              <>
                <Field label="Full name" value={form.name} onChange={set('name')} required />
                <Field label="Email" type="email" value={form.email} onChange={set('email')} required />
                <Field label="Phone (optional)" value={form.phone} onChange={set('phone')} />
                <label className="block">
                  <span className="text-xs text-slate-400">Risk profile (optional)</span>
                  <select value={form.risk_profile} onChange={set('risk_profile')}
                    className="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500">
                    <option value="">—</option>
                    <option value="conservative">Conservative</option>
                    <option value="moderate">Moderate</option>
                    <option value="aggressive">Aggressive</option>
                  </select>
                </label>
              </>
            )}

            <button type="submit" disabled={busy}
              className="w-full py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium transition">
              {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Submit request'}
            </button>
          </form>

          {mode === 'signup' && (
            <p className="mt-3 text-[11px] text-slate-500">
              Access is granted manually. After you submit, your password will be provided to you; then log in with your username.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
