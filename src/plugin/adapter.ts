import type { Observation } from '../shared/protocol.js';

export type ObservationDraft = Omit<Observation, 'sourceID' | 'sequence'>;

type Records = Record<string, unknown>;

function record(value: unknown): Records | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Records) : undefined;
}

function string(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

interface RawEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: Records;
}

function read(event: unknown): RawEvent | undefined {
  const raw = record(event);
  if (!raw) return undefined;
  return {
    id: string(raw.id, 200),
    type: string(raw.type, 120),
    created: typeof raw.created === 'number' ? raw.created : undefined,
    data: record(raw.data),
  };
}

/** The tool name OpenCode attached to a call, never the call input. */
function toolName(data: Records | undefined, fallback: string): string {
  const native = record(data?.native);
  return string(native?.name, 80) ?? fallback;
}

export function sessionIdOf(event: unknown): string | undefined {
  const raw = read(event);
  if (!raw) return undefined;
  const direct = string(raw.data?.sessionID, 120);
  if (direct) return direct;
  const form = record(raw.data?.form);
  return string(form?.sessionID, 120);
}

/**
 * Convert one durable V2 event into office observations. Only routing identifiers
 * and tool names are copied; prompts, tool input, tool output and error text are
 * deliberately dropped so the collector never receives conversation content.
 */
export function normalizeEvent(event: unknown, at: number): ObservationDraft[] {
  const raw = read(event);
  if (!raw || !raw.type) return [];

  const base = (sessionID: string, eventID = raw.id): ObservationDraft =>
    ({ at, sessionID, kind: 'active', ...(eventID ? { eventID } : {}) }) as ObservationDraft;
  const data = raw.data;
  const sessionID = sessionIdOf(event);
  if (!sessionID) return [];

  switch (raw.type) {
    case 'session.tool.called': {
      const callID = string(data?.id, 200);
      if (!callID) return [];
      return [{ ...base(sessionID), kind: 'tool-start', callID, tool: toolName(data, 'unknown tool') }];
    }
    case 'session.tool.success':
    case 'session.tool.failed': {
      const callID = string(data?.id, 200);
      if (!callID) return [];
      return [{ ...base(sessionID), kind: 'tool-end', callID, tool: toolName(data, 'tool') }];
    }
    case 'session.execution.started':
      return [base(sessionID)];
    case 'session.execution.succeeded':
      return [{ ...base(sessionID), kind: 'settled', reason: 'completed' }];
    case 'session.execution.interrupted':
      return [{ ...base(sessionID), kind: 'settled', reason: 'interrupted' }];
    case 'session.execution.failed':
      return [{ ...base(sessionID), kind: 'error' }];
    case 'permission.asked': {
      const requestID = string(data?.id, 200);
      if (!requestID) return [];
      return [{ ...base(sessionID), kind: 'request-open', requestID, requestType: 'permission' }];
    }
    case 'permission.replied': {
      const requestID = string(data?.requestID, 200);
      if (!requestID) return [];
      return [{ ...base(sessionID), kind: 'request-close', requestID, requestType: 'permission' }];
    }
    case 'form.created': {
      const form = record(data?.form);
      const requestID = string(form?.id, 200);
      if (!requestID) return [];
      return [{ ...base(sessionID), kind: 'request-open', requestID, requestType: 'question' }];
    }
    case 'form.replied': {
      const requestID = string(data?.id, 200);
      if (!requestID) return [];
      return [{ ...base(sessionID), kind: 'request-close', requestID, requestType: 'question' }];
    }
    case 'session.deleted':
      return [{ ...base(sessionID), kind: 'removed' }];
    default:
      return [];
  }
}

export const OBSERVED_EVENTS = [
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.interrupted',
  'session.execution.failed',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'session.deleted',
] as const;
