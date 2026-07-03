// Live database process inspection (SHOW PROCESSLIST / pg_stat_activity)
// and kill/terminate, for the Database Explorer's Processes view.

export async function getHostDbProcesses(engine) {
    return this.request(`/databases/${engine}/processes`);
}

export async function killHostDbProcess(engine, pid) {
    return this.request(`/databases/${engine}/processes/${pid}/kill`, { method: 'POST' });
}

export async function getDockerDbProcesses(container, type, user = null, password = null) {
    const headers = password ? { 'X-DB-Password': password } : {};
    const params = new URLSearchParams({ type: type || 'mysql' });
    if (user) params.set('user', user);
    return this.request(`/databases/docker/${container}/processes?${params.toString()}`, { headers });
}

export async function killDockerDbProcess(container, pid, type, user = null, password = null) {
    const headers = password ? { 'X-DB-Password': password } : {};
    return this.request(`/databases/docker/${container}/processes/${pid}/kill`, {
        method: 'POST',
        body: { type: type || 'mysql', user },
        headers,
    });
}
