import { relative } from 'node:path';

export function warningInventory(results, root, sourceFiles) {
    const inventory = {};
    for (const result of results) {
        if (!sourceFiles.has(result.filePath)) continue;
        const file = relative(root, result.filePath).replaceAll('\\', '/');
        for (const message of result.messages) {
            if (message.severity !== 1) continue;
            const rule = message.ruleId || 'unused-disable';
            inventory[file] ||= {};
            inventory[file][rule] = (inventory[file][rule] || 0) + 1;
        }
    }
    return Object.fromEntries(Object.entries(inventory).sort().map(([file, rules]) => [
        file, Object.fromEntries(Object.entries(rules).sort()),
    ]));
}

export function warningRegressions(current, baseline) {
    const regressions = [];
    for (const [file, rules] of Object.entries(current)) {
        for (const [rule, count] of Object.entries(rules)) {
            const ceiling = baseline[file]?.[rule] || 0;
            if (count > ceiling) regressions.push(`${file}: ${rule} has ${count} warnings (ceiling ${ceiling})`);
        }
    }
    return regressions;
}
