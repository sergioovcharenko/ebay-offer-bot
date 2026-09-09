import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('./server-v5.js', import.meta.url), 'utf8');
const fixed = source.replaceAll("\\\\\\\\''+r.id+'\\\\\\\\'", "\\\\''+r.id+'\\\\'");

if (fixed === source) {
  throw new Error('Frontend escape patch did not match server-v5.js');
}

writeFileSync(new URL('./server-v5-runtime.js', import.meta.url), fixed, 'utf8');
