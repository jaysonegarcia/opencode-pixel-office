import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOfficeServer, type OfficeServer } from '../src/server/server.js';
import type { SessionMeta } from '../src/shared/protocol.js';

const meta: SessionMeta = {
  id: 'ses_1',
  title: 'Synthetic task',
  agent: 'build',
  projectID: 'prj_1',
  projectName: 'garden',
  directory: '/synthetic',
};
let stateDir = '';
let staticDir = '';
let server: OfficeServer;
let base = '';

async function boot(options: Partial<Parameters<typeof startOfficeServer>[0]> = {}) {
  server = await startOfficeServer({ port: 0, host: '127.0.0.1', stateDir, staticDir, ...options });
  base = `http://127.0.0.1:${server.port}`;
}

function ingest(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.credential}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function login() {
  const response = await fetch(`${base}/api/bootstrap-code`, { headers: { authorization: `Bearer ${server.credential}` } });
  const { code } = (await response.json()) as { code: string };
  const exchange = await fetch(`${base}/api/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return exchange.headers.getSetCookie()[0] ?? exchange.headers.get('set-cookie') ?? '';
}

const observation = (sequence: number, extra: Record<string, unknown> = {}) => ({
  sourceID: 'src',
  sequence,
  at: Date.now(),
  sessionID: 'ses_1',
  kind: 'active',
  ...extra,
});

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'pixel-office-state-'));
  staticDir = mkdtempSync(join(tmpdir(), 'pixel-office-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Synthetic office</title>');
  await boot();
});

afterEach(async () => {
  await server?.close();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(staticDir, { recursive: true, force: true });
});

describe('collector', () => {
  it('ingestion requires the local credential', async () => {
    expect((await ingest({ sourceID: 'src', observations: [] }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await ingest({ sourceID: 'src', observations: [] }, { authorization: '' })).status).toBe(401);
  });

  it('rejects wrong origin and unexpected host', async () => {
    const event = { sourceID: 'src', observations: [observation(1, { kind: 'metadata', meta })] };
    expect((await ingest(event, { origin: 'https://evil.example' })).status).toBe(403);
    const status = await new Promise<number>((done, fail) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/observations',
          method: 'POST',
          headers: {
            host: 'evil.example',
            'content-type': 'application/json',
            authorization: `Bearer ${server.credential}`,
          },
        },
        response => {
          response.resume();
          done(response.statusCode ?? 0);
        },
      );
      request.on('error', fail);
      request.end(JSON.stringify(event));
    });
    expect(status).toBe(403);
  });

  it('rejects oversized and invalid payloads', async () => {
    const tooMany = { sourceID: 'src', observations: Array.from({ length: 101 }, (_, i) => observation(i + 1)) };
    expect((await ingest(tooMany)).status).toBe(413);
    expect((await ingest('x'.repeat(70_000))).status).toBe(413);
    expect((await ingest({ sourceID: 'src', observations: [{ kind: 'metadata' }] })).status).toBe(400);
    expect((await ingest({ sourceID: 'src', observations: [{ ...observation(1), sourceID: 'other' }] })).status).toBe(400);
    expect((await ingest({ sourceID: 'src', observations: [{ ...observation(1), kind: 'not-a-kind' }] })).status).toBe(400);
    expect((await ingest({ observations: [] })).status).toBe(400);
  });

  it('accepts a valid batch and rejects a reused bootstrap code', async () => {
    const response = await ingest({ sourceID: 'src', observations: [observation(1, { kind: 'metadata', meta }), observation(2)] });
    expect(response.status).toBe(204);
    const { code } = (await (await fetch(`${base}/api/bootstrap-code`, { headers: { authorization: `Bearer ${server.credential}` } })).json()) as { code: string };
    const first = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(first.status).toBe(204);
    const cookie = first.headers.getSetCookie()[0] ?? first.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const second = await fetch(`${base}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(second.status).toBe(401);
  });

  it('snapshot and events require the browser cookie', async () => {
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(401);
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const response = await fetch(`${base}/api/snapshot`, { headers: { cookie: await login() } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 0, sessions: [] });
  });

  it('pushes an SSE snapshot that matches ingested observations', async () => {
    const stream = await fetch(`${base}/api/events`, { headers: { cookie: await login() } });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    await ingest({ sourceID: 'src', observations: [observation(1, { kind: 'metadata', meta }), observation(2)] });
    let seen = '';
    for (let i = 0; i < 5 && !seen.includes('Synthetic task'); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain('event: snapshot');
    expect(seen).toContain('Synthetic task');
    expect(seen).toContain('working');
    await reader.cancel();
  });

  it('never serves a long-lived key to the browser', async () => {
    const cookie = await login();
    const snapshot = await fetch(`${base}/api/snapshot`, { headers: { cookie } });
    expect(JSON.stringify(await snapshot.json())).not.toContain(server.credential);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('marks a session disconnected when its source lease expires', async () => {
    await server.close();
    await boot({ leaseMs: 40, sweepMs: 10 });
    const cookie = await login();
    await ingest({ sourceID: 'src', observations: [observation(1, { kind: 'metadata', meta }), observation(2)] });
    const current = await fetch(`${base}/api/snapshot`, { headers: { cookie } });
    expect(((await current.json()) as { sessions: { status: string }[] }).sessions[0].status).toBe('working');
    await new Promise(resolve => setTimeout(resolve, 300));
    const expired = await fetch(`${base}/api/snapshot`, { headers: { cookie } });
    expect(((await expired.json()) as { sessions: { status: string }[] }).sessions[0].status).toBe('disconnected');
  });

  it('rejects static path traversal', async () => {
    const response = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('root:');
  });
});
