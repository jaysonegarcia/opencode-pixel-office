export interface SessionMeta { id: string; title: string; agent: string; projectID: string; projectName: string; directory: string; parentID?: string }
export interface Observation {
  sourceID: string; sequence: number; at: number; sessionID: string;
  kind: 'metadata' | 'active' | 'tool-start' | 'tool-end' | 'request-open' | 'request-close' | 'settled' | 'error' | 'removed';
  eventID?: string;
  meta?: SessionMeta; callID?: string; tool?: string; requestID?: string; requestType?: 'permission' | 'question'; reason?: 'completed' | 'interrupted';
}
export interface SessionView extends SessionMeta {
  status: 'working' | 'waiting' | 'idle' | 'done' | 'error' | 'disconnected';
  activity: string; tools: {callID: string; tool: string}[]; updatedAt: number;
  history: {at: number; kind: string; label: string}[];
}
export interface OfficeSnapshot { revision: number; sessions: SessionView[]; connectedSources: number; generatedAt: number; capacityReached: boolean }
