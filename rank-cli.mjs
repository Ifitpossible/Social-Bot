import { readFile, writeFile } from 'node:fs/promises';
import { rankPosts } from './ranking.mjs';
const [input, output] = process.argv.slice(2);
if (!input) { console.error('用法：node rank-cli.mjs input.json [output.json]'); process.exit(1); }
const source = JSON.parse(await readFile(input, 'utf8'));
const rows = Array.isArray(source) ? source : source.posts;
const posts = rows.map(p => ({ ...p, id: p.id || p.url?.match(/\/status\/(\d+)/)?.[1] }));
const result = rankPosts(posts, source.settings || {});
const json = JSON.stringify(result, null, 2);
if (output) await writeFile(output, json, 'utf8'); else console.log(json);
