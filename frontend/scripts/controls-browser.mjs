// Verify that shared-control adoption preserves custom SCSS and native form,
// disabled, keyboard, ref and asChild behavior. No application backend required.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, open: false } });
let browser;
try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.resolvedUrls.local[0]}tests/browser/controls.html`);
    await page.locator('#shared-submit').waitFor();
    for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const suffix of ['submit', 'custom', 'disabled', 'card', 'header', 'content']) {
            const pair = await page.evaluate((name) => {
                const props = ['display', 'height', 'minWidth', 'padding', 'margin', 'border', 'borderRadius',
                    'backgroundColor', 'backgroundImage', 'color', 'fontFamily', 'fontSize', 'fontWeight',
                    'opacity', 'cursor', 'pointerEvents', 'boxShadow', 'gap'];
                return ['native', 'shared'].map((prefix) => {
                    const element = document.getElementById(`${prefix}-${name}`);
                    const css = getComputedStyle(element);
                    return { tag: element.tagName, classes: [...new Set(element.classList)].sort(),
                        css: Object.fromEntries(props.map((property) => [property, css[property]])) };
                });
            }, suffix);
            assert.deepEqual(pair[1], pair[0], `${theme}: ${suffix} changed its DOM/CSS contract`);
        }
    }
    assert.equal(await page.evaluate(() => window.controlRef === document.getElementById('shared-custom')), true);
    await page.locator('#shared-custom').click();
    assert.deepEqual(await page.evaluate(() => window.controlEvents), { submits: 0, clicks: 1 });
    await page.locator('#shared-custom').press('Enter');
    assert.deepEqual(await page.evaluate(() => window.controlEvents), { submits: 0, clicks: 2 });
    await page.locator('#shared-submit').click();
    await page.locator('#native-submit').click();
    assert.equal(await page.evaluate(() => window.controlEvents.submits), 2, 'implicit submit behavior changed');
    await page.locator('#shared-disabled').evaluate((node) => node.click());
    assert.equal(await page.evaluate(() => window.controlEvents.clicks), 2, 'disabled button fired');
    assert.equal(await page.locator('#shared-link').evaluate((node) => node.tagName), 'A');
    assert.equal(await page.locator('#shared-link').getAttribute('href'), '#destination');
    assert.deepEqual(errors, []);
    console.log('Controls: dark/light CSS equivalence, refs, form submission, keyboard, disabled and asChild contracts passed.');
} finally {
    await browser?.close();
    await server.close();
}
