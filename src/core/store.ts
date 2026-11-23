import type { Observation, OfficeSnapshot, SessionMeta, SessionView } from '../shared/protocol.js';

const MAX_SESSIONS = 500;
const MAX_HISTORY = 50;
const DONE_IDLE_MS = 15_000;
const LEASE_MS = 30_000;
const MAX_SEEN_EVENTS = 2_000;

interface SessionRecord extends SessionMeta {
  status: SessionView['status'];
  activity: string;
  tools: { callID: string; tool: string }[];
  pending: Map<string, 'permission' | 'question'>;
  updatedAt: number;
  doneAt: number | null;
  history: { at: number; kind: string; label: string }[];
}

interface SourceRecord {
  lastSequence: number;
  lastSeen: number;
  sessions: Set<string>;
  seen: Set<string>;
  seenOrder: string[];
}

const LABELS: Record<Observation['kind'], string> = {
  metadata: 'Session opened',
  active: 'Working',
  'tool-start': 'Running a tool',
  'tool-end': 'Tool finished',
  'request-open': 'Waiting for input',
  'request-close': 'Input received',
  settled: 'Turn finished',
  error: 'Hit an error',
  removed: 'Session closed',
};

export class OfficeStore {
  private sessions = new Map<string, SessionRecord>();
  private sources = new Map<string, SourceRecord>();
  private revision = 0;
  private capacityReached = false;

  apply(events: Observation[]): void {
    let changed = false;
    for (const event of events) {
      if (this.accept(event)) {
        this.reduce(event);
        changed = true;
      }
    }
    if (changed) this.revision += 1;
  }

  heartbeat(sourceID: string, now: number): void {
    const source = this.source(sourceID);
    source.lastSeen = Math.max(source.lastSeen, now);
  }

  disconnect(sourceID: string): void {
    const source = this.sources.get(sourceID);
    if (!source) return;
    for (const id of source.sessions) {
      const session = this.sessions.get(id);
      if (session && session.status !== 'disconnected') {
        session.status = 'disconnected';
        session.activity = 'Connection lost';
      }
    }
  }

  resetSource(sourceID: string): void {
    this.disconnect(sourceID);
    const source = this.sources.get(sourceID);
    if (!source) return;
    for (const id of source.sessions) {
      const session = this.sessions.get(id);
      if (!session) continue;
      session.tools = [];
      session.pending.clear();
    }
    source.lastSequence = 0;
    source.seen.clear();
    source.seenOrder = [];
    this.revision += 1;
  }

  sweep(now: number): void {
    for (const [id, source] of this.sources) {
      if (now - source.lastSeen > LEASE_MS) this.disconnect(id);
    }
    for (const session of this.sessions.values()) {
      if (session.status === 'done' && session.doneAt !== null && now - session.doneAt >= DONE_IDLE_MS) {
        session.status = 'idle';
        session.activity = 'Idle';
        session.doneAt = null;
      }
    }
  }

  snapshot(now: number): OfficeSnapshot {
    const sessions: SessionView[] = [];
    for (const session of this.sessions.values()) {
      sessions.push({
        id: session.id,
        title: session.title,
        agent: session.agent,
        projectID: session.projectID,
        projectName: session.projectName,
        directory: session.directory,
        ...(session.parentID ? { parentID: session.parentID } : {}),
        status: session.status,
        activity: session.activity,
        tools: session.tools.map(tool => ({ ...tool })),
        updatedAt: session.updatedAt,
        history: session.history.map(entry => ({ ...entry })),
      });
    }
    let connectedSources = 0;
    for (const source of this.sources.values()) {
      if (now - source.lastSeen <= LEASE_MS) connectedSources += 1;
    }
    return {
      revision: this.revision,
      sessions,
      connectedSources,
      generatedAt: now,
      capacityReached: this.capacityReached,
    };
  }

  private accept(event: Observation): boolean {
    const source = this.source(event.sourceID);
    if (event.eventID) {
      if (source.seen.has(event.eventID)) return false;
      source.seen.add(event.eventID);
      source.seenOrder.push(event.eventID);
      if (source.seenOrder.length > MAX_SEEN_EVENTS) {
        const oldest = source.seenOrder.shift();
        if (oldest) source.seen.delete(oldest);
      }
    }
    if (Number.isFinite(event.sequence)) {
      if (event.sequence <= source.lastSequence) return false;
      source.lastSequence = event.sequence;
    }
    if (Number.isFinite(event.at)) source.lastSeen = Math.max(source.lastSeen, event.at);
    return true;
  }

  private reduce(event: Observation): void {
    if (event.kind === 'removed') {
      this.sessions.delete(event.sessionID);
      for (const source of this.sources.values()) source.sessions.delete(event.sessionID);
      return;
    }
    const previous = this.sessions.get(event.sessionID);
    if (!previous && event.kind === 'metadata' && this.sessions.size >= MAX_SESSIONS) {
      this.capacityReached = true;
      return;
    }
    const session = previous ?? this.create(event);
    if (!session) return;

    const source = this.source(event.sourceID);
    source.sessions.add(session.id);
    session.updatedAt = Math.max(session.updatedAt, event.at);

    switch (event.kind) {
      case 'metadata':
        if (event.meta) {
          session.title = event.meta.title || session.title;
          session.agent = event.meta.agent || session.agent;
          session.projectID = event.meta.projectID;
          session.projectName = event.meta.projectName;
          session.directory = event.meta.directory;
          if (event.meta.parentID) session.parentID = event.meta.parentID;
        }
        break;
      case 'active':
        session.status = 'working';
        session.activity = 'Thinking';
        break;
      case 'tool-start':
        if (event.callID) {
          session.tools = session.tools.filter(tool => tool.callID !== event.callID);
          session.tools.push({ callID: event.callID, tool: event.tool ?? 'unknown tool' });
        }
        session.status = 'working';
        session.activity = event.tool ? `Using ${event.tool}` : 'Using a tool';
        break;
      case 'tool-end':
        if (event.callID) session.tools = session.tools.filter(tool => tool.callID !== event.callID);
        if (session.pending.size > 0) {
          session.status = 'waiting';
          session.activity = 'Waiting for input';
        } else {
          session.status = 'working';
          session.activity = 'Thinking';
        }
        break;
      case 'request-open':
        if (event.requestID) session.pending.set(event.requestID, event.requestType ?? 'permission');
        session.status = 'waiting';
        session.activity = event.requestType === 'question' ? 'Needs an answer' : 'Needs permission';
        break;
      case 'request-close':
        if (event.requestID) session.pending.delete(event.requestID);
        if (session.pending.size > 0) {
          session.status = 'waiting';
          session.activity = 'Waiting for input';
        } else {
          session.status = 'working';
          session.activity = 'Thinking';
        }
        break;
      case 'settled':
        session.tools = [];
        session.pending.clear();
        if (event.reason === 'interrupted') {
          session.status = 'idle';
          session.activity = 'Interrupted';
          session.doneAt = null;
        } else {
          session.status = 'done';
          session.activity = 'Finished';
          session.doneAt = event.at;
        }
        break;
      case 'error':
        session.tools = [];
        session.pending.clear();
        session.status = 'error';
        session.activity = 'Hit an error';
        break;
    }

    this.record(session, event);
  }

  private create(event: Observation): SessionRecord | undefined {
    const meta = event.meta;
    if (!meta && event.kind !== 'active') return undefined;
    const base: SessionMeta = meta ?? {
      id: event.sessionID,
      title: 'Untitled session',
      agent: 'unknown',
      projectID: 'unknown',
      projectName: 'unknown project',
      directory: '',
    };
    const session: SessionRecord = {
      ...base,
      id: event.sessionID,
      status: 'idle',
      activity: 'Idle',
      tools: [],
      pending: new Map(),
      updatedAt: event.at,
      doneAt: null,
      history: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private record(session: SessionRecord, event: Observation): void {
    const label = LABELS[event.kind];
    session.history.push({ at: event.at, kind: event.kind, label });
    if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);
  }

  private source(sourceID: string): SourceRecord {
    let source = this.sources.get(sourceID);
    if (!source) {
      source = { lastSequence: 0, lastSeen: 0, sessions: new Set(), seen: new Set(), seenOrder: [] };
      this.sources.set(sourceID, source);
    }
    return source;
  }
}
