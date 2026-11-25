import { basename } from 'node:path';
import type { Plugin } from '@opencode/plugin';
import { OfficeStore } from '../core/store.js';
import { normalizeEvent, sessionIdOf, OBSERVED_EVENTS, type ObservationDraft } from './adapter.js';
import type { SessionMeta } from '../shared/protocol.js';

export type ObserverContext = Parameters<Parameters<typeof Plugin.define>[0]['setup']>[0];
export type Emit = (event: ObservationDraft) => void;
const META_EVENTS = ['session.created', 'session.renamed', 'session.agent.selected'];
const clip = (value: string | undefined, fallback: string, length: number) => (value?.trim() || fallback).slice(0, length);

export async function hydrateSession(context: ObserverContext, sessionID: string): Promise<SessionMeta> {
  const info = await context.session.get({ sessionID });
  const directory = info.location.directory;
  return {
    id: info.id, title: clip(info.title, 'Untitled session', 200), agent: clip(info.agent, 'agent', 80),
    projectID: info.projectID, projectName: clip(basename(directory), 'workspace', 120), directory: directory.slice(0, 500),
    ...(info.parentID ? { parentID: info.parentID } : {}),
  };
}

export async function listRunningSessions(context: ObserverContext): Promise<string[]> {
  const running: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await context.session.list({ limit: 100, order: 'desc', archived: false, ...(cursor ? { cursor } : {}) });
    for (const info of response.data) {
      if (info.location.directory !== context.location.directory) continue;
      const { busy, idle } = info.time;
      if (busy !== undefined && (idle === undefined || busy > idle)) running.push(info.id);
    }
    cursor = response.cursor.next ?? undefined;
    if (cursor && seen.has(cursor)) break;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return running;
}

export async function createObserver(context: ObserverContext, emit: Emit) {
  const abort = new AbortController();
  const store = new OfficeStore();
  const requests = new Map<string, Map<string, 'permission' | 'question'>>();
  const owned = new Set<string>();
  const completedCalls = new Set<string>();
  let hydrationGeneration = 0;
  let sequence = 0;
  let healthy = false;
  let retryTimer: NodeJS.Timeout | undefined;
  const send = (draft: ObservationDraft) => {
    if (abort.signal.aborted) return;
    store.heartbeat('local', Date.now());
    store.apply([{ ...draft, sourceID: 'local', sequence: ++sequence }]);
    if (draft.kind === 'request-open' && draft.requestID) {
      if (!requests.has(draft.sessionID)) requests.set(draft.sessionID, new Map());
      requests.get(draft.sessionID)!.set(draft.requestID, draft.requestType ?? 'permission');
    }
    if (draft.kind === 'request-close' && draft.requestID) requests.get(draft.sessionID)?.delete(draft.requestID);
    if (['settled', 'error', 'removed'].includes(draft.kind)) requests.delete(draft.sessionID);
    emit(draft);
  };
  const hydrate = async (id: string) => {
    const meta = await hydrateSession(context, id);
    if (meta.directory !== context.location.directory.slice(0, 500)) return false;
    owned.add(id);
    send({ sessionID: id, at: Date.now(), kind: 'metadata', meta });
    return true;
  };
  const bootstrap = async () => {
    hydrationGeneration++;
    const previous = store.snapshot(Date.now()).sessions;
    for (const session of previous) send({ sessionID: session.id, at: Date.now(), kind: 'settled', reason: 'interrupted' });
    requests.clear();
    for (const id of await listRunningSessions(context)) {
      if (!await hydrate(id)) continue;
      send({ sessionID: id, at: Date.now(), kind: 'active' });
      for (const request of await context.permission.list({ sessionID: id })) {
        send({ sessionID: id, at: Date.now(), kind: 'request-open', requestID: request.id, requestType: 'permission' });
      }
    }
  };
  const registrations = await Promise.all([
    context.tool.hook('execute.before', event => {
      // Only metadata is captured; callbacks return without waiting for I/O.
      const { sessionID, id, tool } = event;
      const generation = hydrationGeneration;
      void (async () => {
        if (!owned.has(sessionID) && !await hydrate(sessionID)) return;
        if (completedCalls.has(`${sessionID}:${id}`) || generation !== hydrationGeneration) return;
        send({ sessionID, at: Date.now(), kind: 'tool-start', callID: id, tool: clip(tool, 'unknown tool', 80) });
      })().catch(() => {});
    }),
    context.tool.hook('execute.after', event => {
      completedCalls.add(`${event.sessionID}:${event.id}`);
      if (completedCalls.size > 2000) completedCalls.delete(completedCalls.values().next().value!);
      if (!owned.has(event.sessionID)) return;
      send({ sessionID: event.sessionID, at: Date.now(), kind: 'tool-end', callID: event.id, tool: clip(event.tool, 'tool', 80) });
    }),
  ]);
  // Subscribe before bootstrap so events during metadata reads are buffered.
  const consume = async () => {
    while (!abort.signal.aborted) {
      const stream = context.event.subscribe({ signal: abort.signal });
      try {
        await bootstrap();
        healthy = true;
        for await (const event of stream) {
          const type = event.type;
          if (![...OBSERVED_EVENTS, ...META_EVENTS].includes(type)) continue;
          const id = sessionIdOf(event);
          if (!id) continue;
          try {
            if (type === 'session.deleted') {
              if (!owned.has(id)) continue;
              owned.delete(id);
            } else if ((!owned.has(id) || META_EVENTS.includes(type)) && !await hydrate(id)) continue;
            for (const draft of normalizeEvent(event, Date.now())) {
              if (draft.kind === 'tool-end') completedCalls.add(`${id}:${draft.callID}`);
              if (['settled', 'error', 'removed'].includes(draft.kind)) hydrationGeneration++;
              send(draft);
            }
          } catch { /* Session may be removed before hydration completes. */ }
        }
      } catch { /* Reconnect below. */ }
      healthy = false;
      if (abort.signal.aborted) break;
      await new Promise<void>(resolve => {
        const finish = () => { if (retryTimer) clearTimeout(retryTimer); abort.signal.removeEventListener('abort', finish); resolve(); };
        retryTimer = setTimeout(finish, 1000);
        abort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  };
  void consume();
  return {
    isHealthy: () => healthy,
    async close() { abort.abort(); await Promise.all(registrations.map(registration => registration.dispose())); },
    reconcile() {
      if (!healthy) throw new Error('OpenCode observer reconnecting');
      store.heartbeat('local', Date.now());
      store.sweep(Date.now());
      const snapshot: ObservationDraft[] = [];
      for (const session of store.snapshot(Date.now()).sessions) {
        const { status, tools, history: _history, activity: _activity, updatedAt: _updatedAt, ...meta } = session;
        const base = { sessionID: session.id, at: Date.now() };
        snapshot.push({ ...base, kind: 'metadata', meta });
        if (status === 'working' || status === 'waiting') snapshot.push({ ...base, kind: 'active' });
        if (status === 'error') snapshot.push({ ...base, kind: 'error' });
        if (status === 'done') snapshot.push({ ...base, kind: 'settled', reason: 'completed' });
        for (const tool of tools) snapshot.push({ ...base, kind: 'tool-start', ...tool });
        for (const [requestID, requestType] of requests.get(session.id) ?? []) snapshot.push({ ...base, kind: 'request-open', requestID, requestType });
      }
      return snapshot;
    },
  };
}
