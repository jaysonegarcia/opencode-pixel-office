import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
const destination = join(config, 'plugins', 'pixel-office.js');
const entry = join(root, 'dist', 'plugin', 'index.js');
await readFile(entry); // Require a successful build before registration.
const content = `export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\n`;
let existing;
try { existing = await readFile(destination, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (existing && existing !== content) {
  console.error(`Observer registration already exists at ${destination}. Inspect it before replacing it.`);
  process.exitCode = 1;
} else {
  await mkdir(dirname(destination), { recursive: true });
  if (!existing) await writeFile(destination, content, { flag: 'wx' });
  console.log(`Observer registered: ${destination}\nCheck with: opencode plugin list\nIf absent, restart OpenCode after saving ongoing work.`);
}
