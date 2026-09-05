// Run normal ESLint, then prevent tracked-source warnings growing by file/rule.
// Installed, ignored extensions still receive normal lint diagnostics, but do
// not change the checked-in baseline on one developer's machine.
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { warningInventory, warningRegressions } from './lint-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
const baselineFile = resolve(root, 'scripts/lint-warning-baseline.json');
const lint = new ESLint({ cwd: root });
const results = await lint.lintFiles(['.']);
const formatter = await lint.loadFormatter('stylish');
const output = formatter.format(results);
if (output) console.log(output);
if (results.some((result) => result.errorCount > 0)) process.exit(1);

// Include new, non-ignored source files so new warnings cannot slip through
// before the file is first staged. Git paths are repository-relative here.
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'frontend'], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).split('\0').filter(Boolean);
const sourceFiles = new Set(paths.map((file) => resolve(repo, file)));
const inventory = warningInventory(results, root, sourceFiles);
if (process.argv.includes('--update')) {
    writeFileSync(baselineFile, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log('Updated tracked-source warning baseline; review the diff before committing.');
} else {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const regressions = warningRegressions(inventory, baseline);
    if (regressions.length) {
        console.error(`New ESLint warnings:\n  ${regressions.join('\n  ')}\nFix new warnings; keep the baseline shrinking.`);
        process.exit(1);
    }
    const count = Object.values(inventory).reduce((total, rules) => total + Object.values(rules).reduce((sum, n) => sum + n, 0), 0);
    console.log(`Tracked-source warnings: ${count}; no file/rule exceeds its reviewed baseline.`);
}
