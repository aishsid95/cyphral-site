/**
 * Static guard against the one SQL mistake that matters most: interpolating
 * a value into query text instead of binding it. Every `.prepare(...)` call
 * anywhere under worker/ must be a plain string/template literal with no
 * `${...}` in it — all data must go through `.bind(...)` instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = collectSourceFiles(workerDir);

describe('SQL safety: no interpolated template literals passed to .prepare()', () => {
  it('scanned at least one file containing a .prepare( call (sanity check the scan itself works)', () => {
    const anyPrepareCalls = sourceFiles.some((file) => readFileSync(file, 'utf8').includes('.prepare('));
    expect(anyPrepareCalls).toBe(true);
  });

  it.each(sourceFiles)('%s has no `${...}` inside a .prepare(`...`) call', (file) => {
    const source = readFileSync(file, 'utf8');
    const prepareCalls = [...source.matchAll(/\.prepare\(\s*`([^`]*)`/g)];
    for (const match of prepareCalls) {
      expect(match[1]).not.toMatch(/\$\{/);
    }
  });
});
