import { describe, expect, it } from 'vitest';
import { normalizeEvent, sessionIdOf } from '../src/plugin/adapter.js';
import { events } from './fixtures/v2.js';

function kinds(event: unknown) {
  return normalizeEvent(event as never, 2000).map(o => o.kind);
}

describe('V2 event adapter', () => {
  it('maps a called tool to a started call using its call id only', () => {
    const observations = normalizeEvent(events.toolCalled('call_a', 'read') as never, 2000);
    expect(observations).toEqual([{ at: 2000, sessionID: 'ses_1', kind: 'tool-start', callID: 'call_a', tool: 'read', eventID: 'evt_call_call_a' }]);
    expect(JSON.stringify(observations)).not.toContain('raw argument');
  });

  it('carries only the tool name from the call', () => {
    const [called] = normalizeEvent({ id: 'e1', type: 'session.tool.called', created: 1, data: { sessionID: 'ses_1', assistantMessageID: 'm', id: 'c', input: {}, executed: true } } as never, 2000);
    expect(called.tool).toBe('unknown tool');
  });

  it('ends the matching call on success or failure', () => {
    expect(normalizeEvent(events.toolSuccess('call_b') as never, 2000)).toEqual([{ at: 2000, sessionID: 'ses_1', kind: 'tool-end', callID: 'call_b', tool: 'tool', eventID: 'evt_done_call_b' }]);
    expect(kinds(events.toolFailed('call_b'))).toEqual(['tool-end']);
  });

  it('maps execution lifecycle without inventing completion', () => {
    expect(kinds(events.started())).toEqual(['active']);
    expect(normalizeEvent(events.succeeded() as never, 2000)[0]).toMatchObject({ kind: 'settled', reason: 'completed' });
    expect(normalizeEvent(events.interrupted() as never, 2000)[0]).toMatchObject({ kind: 'settled', reason: 'interrupted' });
    const failure = normalizeEvent(events.failed() as never, 2000)[0];
    expect(failure.kind).toBe('error');
    expect(JSON.stringify(failure)).not.toContain('private detail');
  });

  it('maps permission and form requests to waiting states', () => {
    expect(normalizeEvent(events.permissionAsked('perm_1') as never, 2000)[0]).toMatchObject({ kind: 'request-open', requestID: 'perm_1', requestType: 'permission' });
    expect(normalizeEvent(events.permissionReplied('perm_1') as never, 2000)[0]).toMatchObject({ kind: 'request-close', requestID: 'perm_1', requestType: 'permission' });
    expect(normalizeEvent(events.formCreated('form_1') as never, 2000)[0]).toMatchObject({ kind: 'request-open', requestID: 'form_1', requestType: 'question' });
    expect(normalizeEvent(events.formReplied('form_1') as never, 2000)[0]).toMatchObject({ kind: 'request-close', requestID: 'form_1', requestType: 'question' });
  });

  it('maps deletion and finds the session to rehydrate', () => {
    expect(kinds(events.deleted())).toEqual(['removed']);
    expect(sessionIdOf(events.renamed('New title'))).toBe('ses_1');
    expect(sessionIdOf(events.agentSelected('plan'))).toBe('ses_1');
    expect(sessionIdOf(events.created())).toBe('ses_1');
    expect(sessionIdOf(events.created('ses_2', 'Child', 'explore', 'ses_1'))).toBe('ses_2');
  });

  it('ignores unrelated events and keeps raw error text out', () => {
    expect(normalizeEvent(events.unknown() as never, 2000)).toEqual([]);
    expect(normalizeEvent({ type: 'session.status', data: {} } as never, 2000)).toEqual([]);
    expect(JSON.stringify(normalizeEvent(events.failed() as never, 2000))).not.toContain('raw error');
  });
});
