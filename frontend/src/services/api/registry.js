// Reject collisions with other domains and with the client's own API. A typo
// must fail at startup instead of silently changing an existing endpoint.
export function bindApiMethods(client, modules) {
    const methods = new Map();
    for (const mod of modules) {
        for (const [name, fn] of Object.entries(mod)) {
            if (typeof fn !== 'function') continue;
            if (name in client || methods.has(name)) {
                throw new Error(`Duplicate API method: ${name}`);
            }
            methods.set(name, fn);
        }
    }
    for (const [name, fn] of methods) client[name] = fn.bind(client);
}
