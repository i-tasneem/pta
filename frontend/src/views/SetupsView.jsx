import React from 'react';
import { Empty } from '../components/ui';
import SetupCard from '../components/SetupCard';
import Playbook from './Playbook';

const DEVELOPING = ['FORMING', 'STRENGTHENING', 'READY'];

// Setups still developing (pre-trigger). Triggered/active ones move to the
// Signals tab. Fed from /api/v2/setups via App.
export default function SetupsView({ setups = [] }) {
  const developing = setups
    .filter((s) => DEVELOPING.includes(s.stage))
    .sort((a, b) => b.score - a.score);

  return (
    <div>
      <Playbook />
      {developing.length === 0 ? (
        <Empty title="No setups forming"
          hint="Positioning setups appear here as they build — a quiet tape is normal" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {developing.map((s) => <SetupCard key={s.id} s={s} />)}
        </div>
      )}
    </div>
  );
}
