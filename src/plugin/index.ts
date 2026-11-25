import { randomUUID } from 'node:crypto';
import { Plugin } from '@opencode/plugin';
import { readLocalCredential, stateDirectory } from '../server/auth.js';
import { createObserver, type ObserverContext } from './observer.js';
import { createTransport } from './transport.js';

export { createObserver, hydrateSession, listRunningSessions } from './observer.js';
export { normalizeEvent, sessionIdOf } from './adapter.js';
export { createTransport } from './transport.js';
export interface ObserverOptions { url?: string; credential?: string; stateDir?: string }

// Each native location observes only sessions belonging to that location.
export async function startObserver(context: ObserverContext, options: ObserverOptions = {}) {
  const credential = options.credential ?? await readLocalCredential(options.stateDir ?? stateDirectory());
  let observer: Awaited<ReturnType<typeof createObserver>> | undefined;
  const transport = createTransport({
    url: options.url ?? 'http://127.0.0.1:4780', credential, sourceID: randomUUID(),
    isHealthy: () => observer?.isHealthy() ?? false,
    onReconcile: () => {
      if (!observer) throw new Error('Observer starting');
      return observer.reconcile();
    },
  });
  try { observer = await createObserver(context, event => transport.enqueue(event)); }
  catch (error) { await transport.close(); throw error; }
  return async () => { await observer?.close(); await transport.close(); };
}

export default Plugin.define({
  id: 'opencode-pixel-office',
  setup: context => startObserver(context, context.options as ObserverOptions),
});
