import type { Observation } from '../shared/protocol.js';
import type { ObservationDraft } from './adapter.js';

export interface TransportOptions {
  url: string; credential: string; sourceID: string;
  retryDelayMs?: number; heartbeatMs?: number;
  onReconcile?: () => Promise<ObservationDraft[] | void> | ObservationDraft[] | void;
  isHealthy?: () => boolean;
}
export interface Transport {
  enqueue(event: ObservationDraft): void;
  stats(): { queued: number; dropped: number };
  close(): Promise<void>;
}

export function createTransport(options: TransportOptions): Transport {
  const url = new URL(options.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Collector URL must use loopback HTTP');
  const base = url.origin;
  let queue: Observation[] = [];
  let sequence = 0;
  let wireSequence = 0;
  let dropped = 0;
  let closed = false;
  let generation: string | undefined;
  let reconcile = true;
  let retry = options.retryDelayMs ?? 1000;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${options.credential}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`Collector ${response.status}`);
    return response.headers.get('x-office-generation') ?? 'legacy';
  };
  const schedule = (delay: number) => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void tick(); }, delay);
    timer.unref();
  };
  const tick = (): Promise<void> => {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      try {
        if (options.isHealthy && !options.isHealthy()) throw new Error('Upstream observer disconnected');
        const current = await post('/api/heartbeat', { sourceID: options.sourceID });
        if (generation !== undefined && current !== generation) reconcile = true;
        generation = current;
        if (reconcile) {
          reconcile = false;
          // Discard stale backlog only when an authoritative rebuild is available.
          if (options.onReconcile) {
            queue = [];
            await post('/api/observations', { sourceID: options.sourceID, reset: true, observations: [] });
            const snapshot = await options.onReconcile();
            if (snapshot) {
              // Snapshot records are streamed separately, never through the lossy live queue.
              let batch: Observation[] = [];
              let size = 100;
              const send = async () => {
                if (!batch.length) return;
                const next = await post('/api/observations', { sourceID: options.sourceID, observations: batch });
                if (next !== generation) throw new Error('Collector restarted during snapshot');
                batch = []; size = 100;
              };
              for (const draft of snapshot) {
                const item = { ...draft, sourceID: options.sourceID, sequence: ++wireSequence };
                const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
                if (batch.length >= 100 || size + bytes > 60_000) await send();
                batch.push(item); size += bytes;
              }
              await send();
            }
          }
        }
        while (queue.length) {
          const batch: Observation[] = [];
          let bytes = 100;
          for (const item of queue.slice(0, 100)) {
            const size = Buffer.byteLength(JSON.stringify(item)) + 1;
            if (bytes + size > 60_000) break;
            batch.push(item); bytes += size;
          }
          if (!batch.length) { queue.shift(); dropped++; reconcile = true; break; }
          const next = await post('/api/observations', { sourceID: options.sourceID, observations: batch.map(item => ({ ...item, sequence: ++wireSequence })) });
          if (next !== generation) throw new Error('Collector restarted during delivery');
          const last = batch.at(-1)!.sequence;
          queue = queue.filter(item => item.sequence > last);
        }
        retry = options.retryDelayMs ?? 1000;
      } catch {
        reconcile = true;
        retry = Math.min(retry * 2, 30_000);
      } finally {
        running = undefined;
        if (!closed) schedule(queue.length || reconcile ? retry : (options.heartbeatMs ?? 10_000));
      }
    });
    return running;
  };
  schedule(0);
  return {
    enqueue(event) {
      if (closed) return;
      queue.push({ ...event, sourceID: options.sourceID, sequence: ++sequence });
      if (queue.length > 500) {
        dropped += queue.length - 500;
        queue.splice(0, queue.length - 500);
        reconcile = true;
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule(0);
    },
    stats: () => ({ queued: queue.length, dropped }),
    async close() {
      if (closed) { await running; return; }
      // Drain pending data once, with bounded request timeouts.
      if (timer) clearTimeout(timer);
      timer = undefined;
      await tick();
      closed = true;
      if (timer) clearTimeout(timer);
      queue = [];
    },
  };
}
