// Before a stylesheet ownership change:
//   node scripts/check-style-cascade.mjs --capture /tmp/serverkit-before.css
// After the change:
//   node scripts/check-style-cascade.mjs --baseline /tmp/serverkit-before.css
//
// Unlike the ownership census, this checks rendered cascade behavior. Fixtures
// cover the legacy shared classes, their descendant/state selectors, and actual
// static JSX class combinations. It is a supplement to real-page visual review,
// not a replacement for it. Requires Playwright's installed Chromium browser.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import postcss from 'postcss';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const capturePath = option('--capture');
const baselinePath = option('--baseline');
if (!capturePath && !baselinePath) {
    throw new Error('Provide --capture <css-file> before editing, or --baseline <css-file> afterward.');
}
const currentCSS = compile(resolve(root, 'src/styles/main.scss'), { logger: { warn() {} } }).css;
if (capturePath) {
    writeFileSync(resolve(capturePath), currentCSS);
    console.log(`Captured CSS: ${resolve(capturePath)}`);
    process.exit(0);
}
const baselineCSS = readFileSync(resolve(baselinePath), 'utf8');
const classNames = [
    'text-secondary', 'text-tertiary', 'font-medium', 'font-semibold', 'font-bold',
    'mono', 'truncate', 'top-bar', 'loading', 'loading-state', 'overview-grid',
    'btn-ghost', 'btn-link', 'btn-icon', 'empty-state', 'error-banner', 'modal-lg',
    'form-row', 'status-badge', 'status-dot', 'badge', 'badge-warning', 'tab-btn',
    'info-list', 'info-item', 'info-label', 'info-value', 'env-list', 'env-item',
    'services-grid', 'logs-viewer', 'wp-list', 'legend-item', 'loading-sm',
    'deploy-tab', 'btn-xs', 'checkbox-label', 'settings-nav-spacer',
    'permission-checkbox', 'sk-modal', 'sk-kpiband-wrap', 'conn-status',
    'spinner-inline', 'data-table', 'monitor-detail', 'settings-form',
    'events-tab', 'settings-tab', 'metrics-tab', 'spin',
];

function splitSelectors(selector) {
    let depth = 0;
    let start = 0;
    const parts = [];
    for (let i = 0; i < selector.length; i += 1) {
        if ('(['.includes(selector[i])) depth += 1;
        if (')]'.includes(selector[i])) depth -= 1;
        if (!depth && selector[i] === ',') {
            parts.push(selector.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(selector.slice(start).trim());
    return parts.filter(Boolean);
}

const selectors = new Set();
for (const css of [baselineCSS, currentCSS]) {
    postcss.parse(css).walkRules((rule) => {
        for (const selector of splitSelectors(rule.selector)) {
            if (classNames.some((name) => selector.includes(`.${name}`))) selectors.add(selector);
        }
    });
}
function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}
for (const path of walk(resolve(root, 'src')).filter((file) => /\.[jt]sx?$/.test(file))) {
    for (const match of readFileSync(path, 'utf8').matchAll(/className\s*=\s*["']([^"']+)["']/g)) {
        if (match[1].split(/\s+/).some((name) => classNames.includes(name))) {
            selectors.add(`.${match[1].trim().replace(/\s+/g, '.')}`);
        }
    }
}
for (const size of ['', 'btn-sm', 'btn-lg', 'btn-xs']) {
    for (const variant of ['', 'btn-primary', 'btn-secondary', 'btn-ghost', 'btn-danger', 'btn-link']) {
        for (const state of ['', ':hover', ':disabled', ':hover:disabled']) {
            for (const icon of ['', 'btn-icon']) {
                selectors.add(['button.btn', icon, size, variant].filter(Boolean).join('.') + state);
            }
        }
    }
}

// Materialize interaction selectors as classes so every state can be checked
// at once, independently of the mouse position or focus of adjacent fixtures.
function simulatedStates(css) {
    return css.replaceAll(':hover', '.test-hover')
        .replaceAll(':focus-visible', '.test-focus-visible')
        .replaceAll(':focus-within', '.test-focus-within')
        .replace(/:focus(?![-\w])/g, '.test-focus');
}

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    await page.setContent(`<style id="target"></style><style>
        .fixture-case { width:600px; height:320px; position:relative; overflow:hidden; margin:12px; contain:layout }
        *,*::before,*::after { animation-play-state:paused!important; transition:none!important }
        </style><main></main>`);
    await page.evaluate((selectors) => {
        function parts(selector) {
            let depth = 0;
            let start = 0;
            const result = [];
            for (let i = 0; i < selector.length; i += 1) {
                if ('(['.includes(selector[i])) depth += 1;
                if (')]'.includes(selector[i])) depth -= 1;
                if (!depth && /[ >+~]/.test(selector[i])) {
                    if (selector.slice(start, i).trim()) result.push(selector.slice(start, i).trim());
                    start = i + 1;
                }
            }
            if (selector.slice(start).trim()) result.push(selector.slice(start).trim());
            return result;
        }
        function make(token) {
            token = token.replace(/:not\([^)]*\)/g, '')
                .replace(/:(is|where)\(([^)]*)\)/g, (_, name, value) => value.split(',')[0])
                .replaceAll(':hover', '.test-hover')
                .replaceAll(':focus-visible', '.test-focus-visible')
                .replaceAll(':focus-within', '.test-focus-within')
                .replace(/:focus(?![-\w])/g, '.test-focus');
            const has = token.match(/:has\(([^)]*)\)/);
            token = token.replace(/:has\([^)]*\)/g, '');
            const element = document.createElement(token.match(/^[A-Za-z][\w-]*/)?.[0] || 'div');
            for (const match of token.matchAll(/\.([\w-]+)/g)) element.classList.add(match[1]);
            for (const match of token.matchAll(/\[([\w-]+)(?:[~|^$*]?=['"]?([^'"\]]+)['"]?)?\]/g)) {
                element.setAttribute(match[1], match[2] ?? '');
            }
            if (token.includes(':disabled')) element.setAttribute('disabled', '');
            if (token.includes(':checked')) element.checked = true;
            if (has) {
                let parent = element;
                for (const part of parts(has[1])) {
                    const child = make(part);
                    parent.append(child);
                    parent = child;
                }
            }
            return element;
        }
        for (const selector of selectors) {
            const wrapper = document.createElement('section');
            wrapper.className = 'fixture-case';
            wrapper.dataset.selector = selector;
            let parent = wrapper;
            for (const part of parts(selector)) {
                const element = make(part);
                parent.append(element);
                parent = element;
            }
            if (!parent.children.length && !['INPUT', 'IMG', 'BR', 'HR', 'SVG'].includes(parent.tagName)) {
                parent.textContent = 'ServerKit sample';
            }
            for (const tag of ['span', 'svg', 'h3', 'p', 'input']) {
                const child = document.createElement(tag);
                if (tag === 'input') child.type = 'checkbox';
                else child.textContent = tag === 'svg' ? '' : 'Example';
                parent.append(child);
            }
            document.querySelector('main').append(wrapper);
        }
    }, [...selectors]);

    const differences = [];
    for (const width of [390, 640, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ['dark', 'light']) {
            await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
            await page.evaluate((css) => { document.querySelector('#target').textContent = css; }, simulatedStates(baselineCSS));
            // Keep snapshots inside Chromium: serializing every CSS property
            // across the automation boundary is much slower than comparing here.
            await page.evaluate(() => {
                window.fixtureNodes = [...document.querySelectorAll('.fixture-case *')];
                window.styleBaseline = window.fixtureNodes.map((element) => {
                    const style = getComputedStyle(element);
                    return Object.fromEntries([...style].filter((property) => !property.startsWith('--')).map((property) => [property, style.getPropertyValue(property)]));
                });
            });
            await page.evaluate((css) => { document.querySelector('#target').textContent = css; }, simulatedStates(currentCSS));
            const changes = await page.evaluate(() => window.fixtureNodes.flatMap((element, index) => {
                const style = getComputedStyle(element);
                const before = window.styleBaseline[index];
                const changed = Object.fromEntries(Object.entries(before).flatMap(([property, value]) => {
                    const after = style.getPropertyValue(property);
                    return value !== after ? [[property, [value, after]]] : [];
                }));
                return Object.keys(changed).length ? [{ selector: element.closest('.fixture-case').dataset.selector, element: element.tagName + '.' + element.className, changed }] : [];
            }));
            differences.push(...changes.map((change) => ({ width, theme, ...change })));
            console.log(`${width}px ${theme}: ${changes.length} differing elements`);
        }
    }
    if (differences.length) {
        const output = option('--output');
        if (output) writeFileSync(resolve(output), JSON.stringify(differences, null, 2));
        console.error(JSON.stringify(differences.slice(0, 10), null, 2));
        throw new Error(`${differences.length} rendered differences across ${selectors.size} fixtures.`);
    }
    console.log(`Style cascade preserved across ${selectors.size} fixtures, five widths, and two themes.`);
} finally {
    await browser.close();
}
