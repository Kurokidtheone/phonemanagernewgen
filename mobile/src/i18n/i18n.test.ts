import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import desktopEn from '../../../src/renderer/src/i18n/en.json';
import ar from './ar.json';
import en from './en.json';
import fr from './fr.json';

type Tree = { [key: string]: string | Tree };
const keys = (tree: Tree, prefix = ''): string[] => Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : keys(v, `${prefix}${k}.`)));
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []));

it('has the same phone-only keys in Arabic, French and English', () => {
  const reference = keys(en).sort();
  expect(keys(fr).sort()).toEqual(reference);
  expect(keys(ar).sort()).toEqual(reference);
});

it('defines every key the phone code asks for, in its own file or the desktop one', () => {
  const own = new Set(keys(en).map((k) => `m.${k}`));
  const desktop = new Set(keys(desktopEn as Tree));
  const missing: string[] = [];
  for (const file of sources(join(__dirname, '..'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (!own.has(match[1]) && !desktop.has(match[1])) missing.push(`${match[1]} (${file.split('src/').pop()})`);
    }
  }
  expect(missing).toEqual([]);
});
