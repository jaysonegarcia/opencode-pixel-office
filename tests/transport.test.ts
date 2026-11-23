import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTransport } from '../src/plugin/transport.js';
import type { Observation } from '../src/shared/protocol.js';

interface Received { authorization?: string; body: string }
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  servers = [];
});

async function collector(handler: (body: string) => { status: number } = () => ({ status: 204 })) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push({ authorization: request.headers.authorization, body });
      response.writeHead(handler(body).status).end();
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, received, server };
}

function observation(sequence: number): Observation {
  return { sourceID: 'source', sequence, at: sequence, sessionID: 'ses_1', kind: 'active' };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('observation transport', () => {
  it('sends bounded batches with the local credential', async () => {
    const { url, received } = await collector();
    const transport = createTransport({ url, credential: 'secret', sourceID: 'source', retryDelayMs: 5, heartbeatMs: 10_000 });
    transport.enqueue(observation(1));
    transport.enqueue(observation(2));
    await transport.close();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].authorization).toBe('Bearer secret');
    expect(JSON.parse(received[0].body)).toMatchObject({ sourceID: 'source', observations: [{ sequence: 1, kind: 'active' }] });
  });

  it('never blocks the caller on a failing collector and closes cleanly', async () => {
    const server = createServer((_request, response) => response.writeHead(500).end());
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const transport = createTransport({ url: `http://127.0.0.1:${address.port}`, credential: 'secret', sourceID: 'source', retryDelayMs: 5, heartbeatMs: 10_000 });
    const started = Date.now();
    for (let i = 0; i < 50; i++) transport.enqueue(observation(i));
    expect(Date.now() - started).toBeLessThan(100);
    await transport.close();
    expect(transport.stats().queued).toBeLessThanOrEqual(500);
  });

  it('drops the oldest observations past the queue bound', async () => {
    const transport = createTransport({ url: 'http://127.0.0.1:1', credential: 'secret', sourceID: 'source', retryDelayMs: 1000, heartbeatMs: 10_000 });
    for (let i = 0; i < 620; i++) transport.enqueue(observation(i));
    expect(transport.stats()).toEqual({ queued: 500, dropped: 120 });
    await transport.close();
  });

  it('reconciles state before sending again after a dropped connection', async () => {
    let up = false;
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { received.push(body); response.writeHead(204).end(); });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const order: string[] = [];
    const transport = createTransport({
      url: `http://127.0.0.1:${address.port}`,
      credential: 'secret',
      sourceID: 'source',
      retryDelayMs: 20,
      heartbeatMs: 10_000,
      onReconcile: async () => { order.push('reconcile'); if (!up) { up = true; } },
    });
    transport.enqueue(observation(1));
    await wait(120);
    expect(order.length).toBeGreaterThan(0);
    transport.enqueue(observation(2));
    await transport.close();
    expect(received.length).toBeGreaterThan(0);
  });

  it('stops sending after close', async () => {
    const { url, received } = await collector();
    const transport = createTransport({ url, credential: 'secret', sourceID: 'source', retryDelayMs: 5, heartbeatMs: 10 });
    transport.enqueue(observation(1));
    await transport.close();
    const count = received.length;
    await wait(60);
    expect(received.length).toBe(count);
    expect(transport.stats().queued).toBe(0);
  });
});
