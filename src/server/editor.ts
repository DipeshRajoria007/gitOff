import { spawn } from 'node:child_process';
import path from 'node:path';
import { exists, which } from './util.js';

const APP_BINS: Record<string, string[]> = {
  cursor: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
  code: [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
  ],
};

const cache = new Map<string, string | null>();

export async function resolveEditor(name: 'cursor' | 'code'): Promise<string | null> {
  if (cache.has(name)) return cache.get(name)!;
  let bin = await which(name);
  if (!bin) {
    for (const p of APP_BINS[name] ?? []) {
      if (await exists(p)) {
        bin = p;
        break;
      }
    }
  }
  cache.set(name, bin);
  return bin;
}

export async function availableEditors(): Promise<string[]> {
  const out: string[] = [];
  for (const e of ['cursor', 'code'] as const) if (await resolveEditor(e)) out.push(e);
  return out;
}

/** Open a folder (and optionally a file at a line) in Cursor / VS Code. */
export async function openInEditor(name: 'cursor' | 'code', folder: string, file?: string, line?: number): Promise<void> {
  const bin = await resolveEditor(name);
  if (!bin) throw new Error(`${name} command-line tool not found. In ${name === 'cursor' ? 'Cursor' : 'VS Code'}, run "Shell Command: Install '${name}' command in PATH".`);
  const args = [folder];
  if (file) {
    const abs = path.resolve(folder, file);
    if (!abs.startsWith(path.resolve(folder) + path.sep)) throw new Error('File is outside the checkout');
    args.push('-g', `${abs}:${line && line > 0 ? line : 1}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
