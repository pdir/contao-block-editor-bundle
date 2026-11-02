// Fails the build when a bundle outgrows its budget (gzip, in KiB).
import { readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budgets = { 'public/shell.js': 9, 'public/restore-settings.js': 0.5, 'public/preview-menu.js': 2, 'public/nav-pages.js': 3, 'public/reader-record.js': 2, 'public/frame.js': 132, 'public/rich-editor.js': 130, 'public/shell.css': 3.5, 'public/frame.css': 1.25 };
let failed = false;

for (const [file, budget] of Object.entries(budgets)) {
  const size = gzipSync(readFileSync(file)).length / 1024;
  const ok = size <= budget;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${size.toFixed(1)} KiB gzip (Budget ${budget} KiB)`);
}

rmSync('var-meta.json', { force: true });
process.exit(failed ? 1 : 0);
