import { RuleTester } from 'eslint';
import rule from './no-static-inline-styles.mjs';

const tester = new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } });
tester.run('no-static-inline-styles', rule, {
    valid: [
        'const view = <div style={{ width: `${progress}%` }} />;',
        'const view = <div style={{ height: rows * rowHeight, color: tone }} />;',
        'const view = <div style={style} />;',
        'const view = <div style={width ? { width } : undefined} />;',
        'const view = <div style={{ "--columns": columns }} />;',
        'const view = <div className={expanded ? "section section--expanded" : "section"} />;',
    ],
    invalid: [
        { code: 'const view = <div style={{ marginTop: 8 }} />;', errors: [{ messageId: 'static' }] },
        { code: 'const view = <div style={{ width, maxWidth: "95vw" }} />;', errors: [{ messageId: 'static' }] },
        { code: 'const view = <div style={open ? { color: "red" } : undefined} />;', errors: [{ messageId: 'static' }] },
        { code: 'const view = <div style={{ color: active ? "red" : "blue" }} />;', errors: [{ messageId: 'static' }] },
        { code: 'const view = <div style={open && { padding: 12 }} />;', errors: [{ messageId: 'static' }] },
        { code: 'const view = <div style={{ margin: -4, padding: 8 }} />;', errors: [{ messageId: 'static' }] },
    ],
});
