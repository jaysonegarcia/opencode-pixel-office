import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfficeStore } from '../core/store.js';
import type { Observation, SessionMeta } from '../shared/protocol.js';
import {
  BrowserSessions,
  readCookie,
  readLocalCredential,
  SESSION_COOKIE,
  secretsMatch,
  stateDirectory,
} from './auth.js';

export interface OfficeServerOptions {
  port?: number;
  host?: string;
  stateDir?: string;
  staticDir?: string;
  leaseMs?: number;
  sweepMs?: number;
  bootstrapTtlMs?: number;
}

export interface OfficeServer {
  port: number;
  credential: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_OBSERVATIONS = 100;
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const KINDS = new Set<Observation['kind']>([
  'metadata',
  'active',
  'tool-start',
  'tool-end',
  'request-open',
  'request-close',
  'settled',
  'error',
  'removed',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function defaultStaticDir(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'ui');
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(':')[0] ?? host;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too-large'> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        done('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      done(Buffer.concat(chunks));
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      fail(error);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseMeta(value: unknown): SessionMeta | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const id = text(raw.id, 120);
  const title = text(raw.title, 200);
  const agent = text(raw.agent, 80);
  const projectID = text(raw.projectID, 120);
  const projectName = text(raw.projectName, 120);
  const directory = typeof raw.directory === 'string' ? raw.directory.slice(0, 500) : undefined;
  const parentID = raw.parentID === undefined ? undefined : text(raw.parentID, 120);
  if (!id || !title || !agent || !projectID || !projectName || directory === undefined) return undefined;
  return { id, title, agent, projectID, projectName, directory, ...(parentID ? { parentID } : {}) };
}

function parseObservation(value: unknown, sourceID: string): Observation | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  if (raw.sourceID !== sourceID) return undefined;
  const sessionID = text(raw.sessionID, 120);
  const sequence = number(raw.sequence);
  const at = number(raw.at);
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind as Observation['kind']) ? (raw.kind as Observation['kind']) : undefined;
  if (!sessionID || sequence === undefined || at === undefined || !kind) return undefined;

  const base: Observation = { sourceID, sequence, at, sessionID, kind };
  if (raw.eventID !== undefined) {
    const eventID = text(raw.eventID, 200);
    if (!eventID) return undefined;
    base.eventID = eventID;
  }

  switch (kind) {
    case 'metadata': {
      const meta = parseMeta(raw.meta);
      if (!meta) return undefined;
      base.meta = meta;
      return base;
    }
    case 'tool-start':
    case 'tool-end': {
      const callID = text(raw.callID, 200);
      if (!callID) return undefined;
      base.callID = callID;
      if (raw.tool !== undefined) {
        const tool = text(raw.tool, 80);
        if (!tool) return undefined;
        base.tool = tool;
      }
      return base;
    }
    case 'request-open':
    case 'request-close': {
      const requestID = text(raw.requestID, 200);
      if (!requestID) return undefined;
      base.requestID = requestID;
      if (kind === 'request-open') {
        const requestType = raw.requestType;
        if (requestType !== 'permission' && requestType !== 'question') return undefined;
        base.requestType = requestType;
      } else if (raw.requestType === 'permission' || raw.requestType === 'question') {
        base.requestType = raw.requestType;
      }
      return base;
    }
    case 'settled': {
      const reason = raw.reason;
      if (reason !== 'completed' && reason !== 'interrupted') return undefined;
      base.reason = reason;
      return base;
    }
    default:
      return base;
  }
}

export async function startOfficeServer(options: OfficeServerOptions = {}): Promise<OfficeServer> {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Collector must bind to loopback');
  const generation = randomUUID();
  const credential = await readLocalCredential(options.stateDir ?? stateDirectory());
  const store = new OfficeStore({ leaseMs: options.leaseMs });
  const sessions = new BrowserSessions();
  const subscribers = new Set<ServerResponse>();
  const staticDir = resolve(options.staticDir ?? defaultStaticDir());
  const bootstrapTtlMs = options.bootstrapTtlMs ?? 60_000;

  let broadcastTimer: NodeJS.Timeout | undefined;
  let closing = false;

  const writeSnapshots = () => {
    if (closing || subscribers.size === 0) return;
    const payload = JSON.stringify(store.snapshot(Date.now()));
    for (const res of [...subscribers]) {
      if (res.writableLength > 1_000_000) {
        subscribers.delete(res);
        res.destroy();
        continue;
      }
      res.write(`event: snapshot\ndata: ${payload}\n\n`);
    }
  };

  const scheduleBroadcast = () => {
    if (broadcastTimer || closing) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      writeSnapshots();
    }, 20);
    broadcastTimer.unref();
  };

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    const before = store.snapshot(now).revision;
    store.sweep(now);
    if (store.snapshot(now).revision !== before) scheduleBroadcast();
  }, options.sweepMs ?? 2_000);
  sweepTimer.unref();

  const guardRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
    const hostHeader = req.headers.host;
    if (!hostHeader || !ALLOWED_HOSTNAMES.has(hostnameOf(hostHeader))) {
      sendText(res, 403, 'Forbidden host');
      return false;
    }
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const parsed = new URL(origin);
        const port = String((req.socket.localPort ?? 0));
        allowed =
          parsed.protocol === 'http:' &&
          ALLOWED_HOSTNAMES.has(parsed.hostname) &&
          (parsed.port || '80') === port;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        sendText(res, 403, 'Forbidden origin');
        return false;
      }
    }
    return true;
  };

  const bearerAllowed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return false;
    return secretsMatch(header.slice('Bearer '.length).trim(), credential);
  };

  const cookieAllowed = (req: IncomingMessage): boolean => sessions.verify(readCookie(req.headers.cookie, SESSION_COOKIE));

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendText(res, 404, 'Not found');
      return;
    }
    if (decoded.includes('\0')) {
      sendText(res, 404, 'Not found');
      return;
    }
    let target = resolve(staticDir, decoded.replace(/^\/+/, ''));
    if (target !== staticDir && !target.startsWith(staticDir + sep)) {
      sendText(res, 404, 'Not found');
      return;
    }
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, 'index.html');
      const data = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-length': data.byteLength,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendText(res, 404, 'Not found');
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (!guardRequest(req, res)) return;

    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', name: 'opencode-pixel-office', version: '0.1.0', uptime: Math.round(process.uptime()) });
      return;
    }

    if (pathname === '/api/observations') {
      if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed');
      if (!bearerAllowed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readBody(req, MAX_BODY_BYTES);
      if (body === 'too-large') return sendJson(res, 413, { error: 'payload too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      const envelope = asRecord(parsed);
      const sourceID = envelope ? text(envelope.sourceID, 200) : undefined;
      const rawObservations = envelope?.observations;
      if (!sourceID || !Array.isArray(rawObservations)) return sendJson(res, 400, { error: 'invalid envelope' });
      if (rawObservations.length > MAX_OBSERVATIONS) return sendJson(res, 413, { error: 'too many observations' });
      const observations: Observation[] = [];
      for (const item of rawObservations) {
        const observation = parseObservation(item, sourceID);
        if (!observation) return sendJson(res, 400, { error: 'invalid observation' });
        observations.push(observation);
      }
      const now = Date.now();
      if (envelope?.reset === true) store.resetSource(sourceID);
      store.heartbeat(sourceID, now);
      store.apply(observations);
      scheduleBroadcast();
      res.writeHead(204, { 'x-office-generation': generation }).end();
      return;
    }

    if (pathname === '/api/heartbeat') {
      if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed');
      if (!bearerAllowed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readBody(req, 4096);
      if (body === 'too-large') return sendJson(res, 413, { error: 'payload too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      const sourceID = asRecord(parsed) ? text((parsed as Record<string, unknown>).sourceID, 200) : undefined;
      if (!sourceID) return sendJson(res, 400, { error: 'invalid heartbeat' });
      store.heartbeat(sourceID, Date.now());
      scheduleBroadcast();
      res.writeHead(204, { 'x-office-generation': generation }).end();
      return;
    }

    if (pathname === '/api/bootstrap-code') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      if (!bearerAllowed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      sendJson(res, 200, { code: sessions.issueCode(Date.now(), bootstrapTtlMs), expiresIn: Math.round(bootstrapTtlMs / 1000) });
      return;
    }

    if (pathname === '/api/bootstrap') {
      if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed');
      const body = await readBody(req, 4096);
      if (body === 'too-large') return sendJson(res, 413, { error: 'payload too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'invalid json' });
      }
      const code = asRecord(parsed) ? text((parsed as Record<string, unknown>).code, 400) : undefined;
      const token = code ? sessions.exchange(code, Date.now()) : undefined;
      if (!token) return sendJson(res, 401, { error: 'invalid code' });
      res.writeHead(204, {
        'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (pathname === '/api/snapshot') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      if (!cookieAllowed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      sendJson(res, 200, store.snapshot(Date.now()));
      return;
    }

    if (pathname === '/api/events') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      if (!cookieAllowed(req)) return sendJson(res, 401, { error: 'unauthorized' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      subscribers.add(res);
      writeSnapshots();
      req.on('close', () => subscribers.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    await serveStatic(req, res, pathname);
  };

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.destroy();
    });
  });

  await new Promise<void>((done, fail) => {
    const onError = (error: NodeJS.ErrnoException) => {
      httpServer.off('listening', onListening);
      fail(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      done();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(options.port ?? 4780, host);
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 4780);

  return {
    port,
    credential,
    async close() {
      closing = true;
      clearInterval(sweepTimer);
      if (broadcastTimer) clearTimeout(broadcastTimer);
      for (const res of subscribers) res.destroy();
      subscribers.clear();
      await new Promise<void>(done => {
        httpServer.close(() => done());
        httpServer.closeAllConnections();
      });
    },
  };
}
