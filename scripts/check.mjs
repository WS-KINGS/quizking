import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', `src/${file}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const file of ['src/manifest.json', 'src/_locales/zh_CN/messages.json']) {
  JSON.parse(readFileSync(file, 'utf8'));
}
console.log('All extension scripts and JSON files are valid.');
