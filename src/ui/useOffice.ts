import { useEffect, useState } from 'react';
import type { OfficeSnapshot } from '../shared/protocol.js';

export function useOffice() {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let stream: EventSource | undefined;
    const abort = new AbortController();
    const start = async () => {
      try {
        const code = new URLSearchParams(location.hash.slice(1)).get('code');
        if (code) {
          history.replaceState(null, '', location.pathname + location.search);
          const response = await fetch('/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), signal: abort.signal });
          if (!response.ok) throw new Error('Your sign-in link expired. Run yarn office:open to get a new one.');
        }
        const response = await fetch('/api/snapshot', { signal: abort.signal });
        if (response.status === 401) throw new Error('Open this office with yarn office:open to sign in.');
        if (!response.ok) throw new Error('The collector is unavailable. Start it with yarn start.');
        const initial = await response.json() as OfficeSnapshot;
        if (stopped) return;
        setSnapshot(initial);
        stream = new EventSource('/api/events');
        let revision = -1;
        stream.onopen = () => { revision = -1; setConnection('live'); setError(''); };
        stream.addEventListener('snapshot', event => {
          try {
            const next = JSON.parse((event as MessageEvent).data) as OfficeSnapshot;
            if (next.revision < revision) return;
            revision = next.revision;
            setSnapshot(next);
          } catch { setError('An office update could not be read. Reconnecting…'); }
        });
        stream.onerror = () => {
          setConnection('reconnecting');
          void fetch('/api/snapshot', { signal: abort.signal }).then(check => {
            if (check.status === 401 && !stopped) {
              stream?.close();
              setConnection('offline');
              setError('The collector restarted. Run yarn office:open to sign in again. Displayed data is stale.');
            }
          }).catch(() => {});
        };
      } catch (e) {
        if (stopped) return;
        setConnection('offline');
        setError(e instanceof Error ? e.message : 'Unable to connect to the office.');
      }
    };
    void start();
    return () => { stopped = true; abort.abort(); stream?.close(); };
  }, []);
  return { snapshot, connection, error };
}
