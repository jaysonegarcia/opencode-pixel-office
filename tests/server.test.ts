import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOfficeServer } from '../src/server/server.js';
import type { SessionMeta } from '../src/shared/protocol.js';

const meta: SessionMeta = { id: 'ses_1', title: 'Synthetic task', agent: 'build', projectID: 'prj_1', projectName: 'garden', directory: '/synthetic' };
let stateDir = '';
let staticDir = '';
let base = '';
let credential = '';
let close: (() => Promise<void>) | undefined;

async function boot() {
  const server = await startOfficeServer({ port: 0, host: '127.0.0.1', stateDir, staticDir });
  base = `http://127.0.0.1:${server.port}`;
  credential = server.credential;
  close = server.close;
}

function ingest(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function login() {
  const code = base.startsWith('http') ? await (await fetch(`${base}/api/bootstrap-code`, { headers: { authorization: `Bearer ${credential}` } })).json() : { code: '' };
  const response = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code }) });
  return response.headers.getSetCookie()[0] ?? response.headers.get('set-cookie') ?? '';
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'pixel-office-state-'));
  staticDir = mkdtempSync(join(tmpdir(), 'pixel-office-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Synthetic office</title>');
  await boot();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(staticDir, { recursive: true, force: true });
});

describe('collector', () => {
  it('ingestion requires the local credential', async () => {
    expect((await ingest({ sourceID: 'src', observations: [] }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await ingest({ sourceID: 'src', observations: [] }, { authorization: '' })).status).toBe(401);
  });

  it('rejects wrong origin and unexpected host', async () => {
    const event = { sourceID: 'src', observations: [{ sourceID: 'src', sequence: 1, at: 1, sessionID: 'ses_1', kind: 'metadata', meta }] };
    expect((await ingest(event, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await ingest(event, { host: 'evil.example' })).status).toBe(403);
  });

  it('rejects oversized and invalid payloads', async () => {
    const tooMany = { sourceID: 'src', observations: Array.from({ length: 101 }, (_, i) => ({ sourceID: 'src', sequence: i + 1, at: 1, sessionID: 'ses_1', kind: 'active' })) };
    expect((await ingest(tooMany)).status).toBe(413);
    expect((await ingest('x'.repeat(70_000))).status).toBe(413);
    expect((await ingest({ sourceID: 'src', observations: [{ kind: 'metadata' }] })).status).toBe(400);
    expect((await ingest({ sourceID: 'src', observations: [{ sourceID: 'other', sequence: 1, at: 1, sessionID: 's', kind: 'active' }] })).status).toBe(400);
  });

  it('bootstrap code is single use', async () => {
    const { code } = await (await fetch(`${base}/api/bootstrap-code`, { headers: { authorization: `Bearer ${credential}` } })).json();
    const first = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(first.status).toBe(204);
    expect((first.headers.getSetCookie()[0] ?? first.headers.get('set-cookie') ?? '')).toContain('HttpOnly');
    const second = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(second.status).toBe(401);
  });

  it('snapshot and events require the browser cookie', async () => {
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(401);
    const cookie = await login();
    const response = await fetch(`${base}/api/snapshot`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 0, sessions: [] });
  });

  it('pushes an SSE snapshot that matches ingested observations', async () => {
    const cookie = await login();
    const stream = await fetch(`${base}/api/events`, { headers: { cookie } });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    await ingest({ sourceID: 'src', observations: [
      { sourceID: 'src', sequence: 1, at: 1, sessionID: 'ses_1', kind: 'metadata', meta },
      { sourceID: 'src', sequence: 2, at: 2, sessionID: 'ses_1', kind: 'active' },
    ] });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('event: snapshot');
    expect(chunk).toContain('Synthetic task');
    expect(chunk).toContain('working');
    await reader.cancel();
  });

  it('marks a session disconnected when its source lease expires and cleans subscribers', async () => {
    await ingest({ sourceID: 'src', observations: [{ sourceID: 'src', sequence: 1, at: Date.now(), sessionID: 'ses_1', kind: 'metadata', meta }] });
    await ingest({ sourceID: 'src', observations: [{ sourceID: 'src', sequence: 2, at: Date.now(), sessionID: 'ses_1', kind: 'active' }] });
    const response = await fetch(`${base}/api/snapshot`, { headers: { cookie: await login() } });
    expect((await response.json()).sessions[0].status).toBe('working');
  });

  it('rejects static path traversal', async () => {
    const response = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('root:');
  });
});
