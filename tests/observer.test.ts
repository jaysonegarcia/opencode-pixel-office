import { describe, expect, it } from 'vitest';
import { hydrateSession, listRunningSessions, type ObserverContext } from '../src/plugin/observer.js';

// Synthetic SDK boundary: no live OpenCode instance or session data in tests.
describe('V2 metadata reads', () => {
  it('clips labels before ingestion and preserves child identity', async () => {
    const context = { session: { get: async () => ({ id: 'child', parentID: 'parent', title: 'x'.repeat(300), agent: 'explore', projectID: 'p', location: { directory: '/synthetic/garden' } }) } } as unknown as ObserverContext;
    expect(await hydrateSession(context, 'child')).toEqual({ id: 'child', parentID: 'parent', title: 'x'.repeat(200), agent: 'explore', projectID: 'p', projectName: 'garden', directory: '/synthetic/garden' });
  });
  it('walks pagination and admits only running sessions owned by its location', async () => {
    const cursors: (string | undefined)[] = [];
    const context = {
      location: { directory: '/synthetic/a' },
      session: { list: async ({ cursor }: { cursor?: string }) => {
        cursors.push(cursor);
        return cursor ? { data: [{ id: 'child', location: { directory: '/synthetic/a' }, time: { busy: 20, idle: 10 } }], cursor: {} } : {
          data: [
            { id: 'other-project', location: { directory: '/synthetic/b' }, time: { busy: 20, idle: 10 } },
            { id: 'finished', location: { directory: '/synthetic/a' }, time: { busy: 10, idle: 20 } },
          ], cursor: { next: 'page2' },
        };
      } },
    } as unknown as ObserverContext;
    expect(await listRunningSessions(context)).toEqual(['child']);
    expect(cursors).toEqual([undefined, 'page2']);
  });
});
