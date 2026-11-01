// Verifies that en.json and de.json expose exactly the same key set and that no value is empty.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(here, '..', 'src', name), 'utf8'));
const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const en = flatten(load('en.json'));
const de = flatten(load('de.json'));
const missingInDe = Object.keys(en).filter((k) => !(k in de));
const missingInEn = Object.keys(de).filter((k) => !(k in en));
const empty = [...Object.entries(en), ...Object.entries(de)].filter(([, v]) => v === '' || v == null).map(([k]) => k);
let failed = false;
if (missingInDe.length) { console.error('Missing in de.json:', missingInDe); failed = true; }
if (missingInEn.length) { console.error('Missing in en.json:', missingInEn); failed = true; }
if (empty.length) { console.error('Empty values:', empty); failed = true; }
if (failed) process.exit(1);
console.log(`Locale check passed: ${Object.keys(en).length} keys in both locales.`);
