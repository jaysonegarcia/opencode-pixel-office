import { describe, expect, it } from 'vitest';
import { OfficeStore } from '../src/core/store.js';
import type { Observation, SessionMeta } from '../src/shared/protocol.js';

const meta: SessionMeta = { id: 's1', title: 'Build a garden', agent: 'build', projectID: 'p1', projectName: 'garden', directory: '/synthetic/garden' };
function fixture() {
  const store = new OfficeStore(); let sequence = 0;
  const send = (event: Omit<Observation, 'sourceID' | 'sequence' | 'at' | 'sessionID'> & Partial<Observation>) => store.apply([{ sourceID: 'source', sequence: ++sequence, at: 1000 + sequence, sessionID: 's1', ...event } as Observation]);
  store.heartbeat('source', 1000); send({ kind: 'metadata', meta });
  const view = () => store.snapshot(1010).sessions[0];
  return { store, send, view };
}
describe('session state', () => {
  it('an expired predecessor cannot disconnect the replacement owner', () => {
    const { store, send, view } = fixture();
    send({ kind: 'active' });
    store.heartbeat('replacement', 32000);
    store.apply([{ sourceID: 'replacement', sequence: 1, sessionID: 's1', kind: 'active', at: 32000 }]);
    store.sweep(32001);
    expect(view().status).toBe('working');
  });
  it('keeps waiting visible when another tool starts', () => {
    const { send, view } = fixture();
    send({ kind: 'request-open', requestID: 'p', requestType: 'permission' });
    send({ kind: 'tool-start', callID: 't', tool: 'read' });
    expect(view().status).toBe('waiting');
  });
  it('increments revisions when leases or completion timers change', () => {
    const { store, send } = fixture();
    send({ kind: 'settled', reason: 'completed' });
    const before = store.snapshot(1010).revision;
    store.sweep(20000);
    expect(store.snapshot(20000).revision).toBeGreaterThan(before);
    const idle = store.snapshot(20000).revision;
    store.sweep(32000);
    expect(store.snapshot(32000).revision).toBeGreaterThan(idle);
  });
  it('deduplicates the same event across sources', () => {
    const { store, view } = fixture();
    const event: Observation = { sourceID: 'source', sequence: 2, at: 1002, sessionID: 's1', kind: 'active', eventID: 'shared' };
    store.apply([event, { ...event, sourceID: 'second', sequence: 1 }]);
    expect(view().history.filter(h => h.kind === 'active')).toHaveLength(1);
  });
  it('overlapping tools remain active', () => {
    const { send, view } = fixture();
    send({ kind: 'tool-start', callID: 'a', tool: 'read' }); send({ kind: 'tool-start', callID: 'b', tool: 'shell' });
    send({ kind: 'tool-end', callID: 'a', tool: 'read' });
    expect(view().tools).toEqual([{ callID: 'b', tool: 'shell' }]); expect(view().status).toBe('working');
  });
  it('requests outrank tools until all resolved', () => {
    const { send, view } = fixture();
    send({ kind: 'request-open', requestID: 'a', requestType: 'permission' }); send({ kind: 'request-open', requestID: 'b', requestType: 'question' });
    send({ kind: 'tool-start', callID: 't', tool: 'read' }); send({ kind: 'request-close', requestID: 'a', requestType: 'permission' });
    expect(view().status).toBe('waiting'); send({ kind: 'request-close', requestID: 'b', requestType: 'question' }); expect(view().status).toBe('working');
  });
  it('tool end is not turn end; settlement clears calls and becomes idle', () => {
    const { store, send, view } = fixture();
    send({ kind: 'tool-start', callID: 'a', tool: 'read' }); send({ kind: 'tool-end', callID: 'a', tool: 'read' });
    expect(view().status).toBe('working'); send({ kind: 'tool-start', callID: 'b', tool: 'shell' }); send({ kind: 'settled', reason: 'completed' });
    expect(view().tools).toEqual([]); expect(view().status).toBe('done'); store.sweep(20000); expect(view().status).toBe('idle');
  });
  it('ignores duplicates and old sequences', () => {
    const { store, view } = fixture();
    const event: Observation = { sourceID: 'source', sequence: 4, at: 1004, sessionID: 's1', kind: 'active' };
    store.apply([event, event, { ...event, sequence: 3, kind: 'error' }]);
    expect(view().status).toBe('working'); expect(view().history.filter(h => h.kind === 'active')).toHaveLength(1);
  });
  it('preserves projects, children and agent changes', () => {
    const { store, send, view } = fixture();
    send({ kind: 'metadata', sessionID: 'child', meta: { ...meta, id: 'child', parentID: 's1', projectID: 'p2', projectName: 'park', agent: 'explore' } });
    send({ kind: 'metadata', meta: { ...meta, agent: 'plan' } });
    expect(view().agent).toBe('plan'); expect(store.snapshot(1010).sessions[1]).toMatchObject({ parentID: 's1', projectName: 'park', agent: 'explore' });
  });
  it('recovers from error on a new turn and handles interruption', () => {
    const { send, view } = fixture(); send({ kind: 'error' }); expect(view().status).toBe('error');
    send({ kind: 'active' }); expect(view().status).toBe('working'); send({ kind: 'settled', reason: 'interrupted' }); expect(view().status).toBe('idle');
  });
  it('disconnect is not done; reconciliation clears stale tools', () => {
    const { store, send, view } = fixture(); send({ kind: 'tool-start', callID: 'a', tool: 'read' });
    store.sweep(32000); expect(view().status).toBe('disconnected');
    store.resetSource('source'); store.heartbeat('source', 33000); send({ kind: 'metadata', meta }); send({ kind: 'active' });
    expect(view().tools).toEqual([]); expect(view().status).toBe('working');
  });
  it('bounds history and removes deleted sessions', () => {
    const { store, send, view } = fixture(); for (let i = 0; i < 100; i++) send({ kind: 'active' });
    expect(view().history.length).toBeLessThanOrEqual(50); send({ kind: 'removed' }); expect(store.snapshot(2000).sessions).toEqual([]);
  });
});
