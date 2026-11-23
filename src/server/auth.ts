import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base = xdg ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'opencode-pixel-office');
}

export async function readLocalCredential(directory = stateDirectory()): Promise<string> {
  const file = join(directory, 'credential');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch {
    // No credential yet; create one below.
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credential = randomBytes(32).toString('hex');
  await writeFile(file, credential, { mode: 0o600, flag: 'w' });
  await chmod(file, 0o600);
  return credential;
}

export function secretsMatch(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class BrowserSessions {
  private codes = new Map<string, number>();
  private tokens = new Set<string>();

  issueCode(now = Date.now(), ttlMs = 60_000): string {
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, now + ttlMs);
    return code;
  }

  exchange(code: string, now = Date.now()): string | undefined {
    const expires = this.codes.get(code);
    this.codes.delete(code);
    if (expires === undefined || expires < now) return undefined;
    const token = randomBytes(32).toString('base64url');
    this.tokens.add(token);
    return token;
  }

  verify(token: string | undefined): boolean {
    return token !== undefined && this.tokens.has(token);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export const SESSION_COOKIE = 'pixel_office_session';
