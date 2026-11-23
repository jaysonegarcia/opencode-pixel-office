#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readLocalCredential, stateDirectory } from './auth.js';
import { startOfficeServer } from './server.js';

const HELP = `opencode-pixel-office — a local pixel-art office for OpenCode V2 sessions

Usage:
  opencode-pixel-office start [--port 4780] [--open]
  opencode-pixel-office open [--port 4780]
  opencode-pixel-office status [--port 4780]
  opencode-pixel-office --help

Commands:
  start   Run the collector and UI in the foreground.
  open    Sign this browser in with a one-time link and open the office.
  status  Show whether the collector is running.

The collector only listens on 127.0.0.1. The long-lived local credential is
stored in ${stateDirectory()} and is never sent to the browser.
`;

interface Args {
  command: string;
  port: number;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const command = argv.find(arg => !arg.startsWith('-')) ?? '--help';
  const portIndex = argv.indexOf('--port');
  const rawPort = portIndex === -1 ? undefined : argv[portIndex + 1];
  const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : 4780;
  return { command, port, open: argv.includes('--open') };
}

function uiDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
}

async function baseUrl(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`collector answered with ${response.status}`);
  return `http://127.0.0.1:${port}`;
}

async function requestCode(port: number): Promise<string> {
  const credential = await readLocalCredential(stateDirectory());
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/bootstrap-code`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    throw new Error(`No collector is listening on http://127.0.0.1:${port}. Start one with: opencode-pixel-office start`);
  }
  if (!response.ok) throw new Error(`Could not sign in: the collector answered with ${response.status}.`);
  const { code } = (await response.json()) as { code: string };
  return code;
}

function launch(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    console.log(`Open this link in a browser:\n\n  ${url}\n`);
  });
  child.unref();
}

async function openBrowser(port: number): Promise<void> {
  const code = await requestCode(port);
  const url = `http://127.0.0.1:${port}/#code=${encodeURIComponent(code)}`;
  launch(url);
  console.log(`Signing in with a one-time link (valid for 60 seconds).\nIf the browser did not open, visit:\n\n  ${url}\n`);
}

async function status(port: number): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await response.json()) as { name?: string; version?: string; uptime?: number };
    console.log(`Collector is running at http://127.0.0.1:${port} (${health.name ?? 'unknown'} ${health.version ?? ''}, up ${health.uptime ?? 0}s).`);
  } catch {
    console.log(`No collector is running at http://127.0.0.1:${port}.`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === '--help' || args.command === '-h' || args.command === 'help') {
    console.log(HELP);
    return;
  }
  if (args.command === 'open') {
    await openBrowser(args.port);
    return;
  }
  if (args.command === 'status') {
    await status(args.port);
    return;
  }
  if (args.command !== 'start') {
    console.error(`Unknown command: ${args.command}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  let server: Awaited<ReturnType<typeof startOfficeServer>>;
  try {
    server = await startOfficeServer({ port: args.port, host: '127.0.0.1', staticDir: join(uiDirectory()) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`Port ${args.port} is already in use. Stop the other process or choose another port with --port.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(`Pixel office collector listening at http://127.0.0.1:${server.port}`);
  console.log(`Open the office with: opencode-pixel-office open --port ${server.port}`);
  if (args.open) await openBrowser(server.port).catch(error => console.error((error as Error).message));

  await new Promise<void>(resolvePromise => {
    const stop = () => {
      void server.close().finally(() => resolvePromise());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('Pixel office stopped.');
}

void main().catch(error => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
