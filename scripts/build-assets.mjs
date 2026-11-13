import { readFile, writeFile } from 'node:fs/promises';
const names = ['index.html', 'style.css', 'app.js', 'privacy.html', 'logo.svg'];
const assets = Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')).replace(/^\uFEFF/, '')])));
await writeFile(new URL('../cloudflare/assets.js', import.meta.url), `export const assets = ${JSON.stringify(assets)};\n`);
