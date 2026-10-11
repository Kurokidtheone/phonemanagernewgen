import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from './ar.json';
import en from './en.json';
import fr from './fr.json';

type Tree = { [key: string]: string | Tree };

function keys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : keys(v, `${prefix}${k}.`)));
}

function sources(dir: string, pattern = /\.tsx?$/): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name), pattern) : pattern.test(e.name) && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

describe('translations', () => {
  it('has the same keys in Arabic, French and English', () => {
    const reference = keys(en).sort();
    expect(keys(fr).sort()).toEqual(reference);
    expect(keys(ar).sort()).toEqual(reference);
  });

  it('defines every literal key the code asks for', () => {
    const known = new Set(keys(en));
    const missing = new Set<string>();
    for (const file of sources(join(__dirname, '..'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        if (!known.has(match[1])) missing.add(`${match[1]} (${file.split('src/').pop()})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('has a message for every error code the Rust core can return', () => {
    const root = join(__dirname, '../../../../core/src');
    const known = new Set(keys(en).filter((k) => k.startsWith('errors.')).map((k) => k.slice(7)));
    const missing = new Set<string>();
    for (const file of sources(root, /\.rs$/)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:bail!|\bapp|\bapp_with)\(\s*"([a-z_]+)"|\bfailed\(\d+,\s*"([a-z_]+)"/g)) {
        const code = match[1] ?? match[2];
        if (!known.has(code)) missing.add(`${code} (${file.split('core/src/').pop()})`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
