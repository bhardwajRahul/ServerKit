// Test Sandbox API — distro-matrix test runs executed in Docker containers.

export async function getTestSandboxDistros() {
    return this.request('/test-sandbox/distros');
}

export async function getTestSandboxRuns(limit = 20) {
    return this.request(`/test-sandbox/runs?limit=${limit}`);
}

export async function startTestSandboxRun(distros, mode) {
    return this.request('/test-sandbox/runs', { method: 'POST', body: { distros, mode } });
}

export async function getTestSandboxRun(id) {
    return this.request(`/test-sandbox/runs/${id}`);
}

export async function cancelTestSandboxRun(id) {
    return this.request(`/test-sandbox/runs/${id}/cancel`, { method: 'POST' });
}

// Plain-text log — the base request() always parses JSON, so fetch directly
// with the same auth-header pattern used for other raw responses (see ai.js).
export async function getTestSandboxRunLog(id, distro) {
    const token = this.getToken();
    const res = await fetch(`${this.baseUrl}/test-sandbox/runs/${id}/logs/${encodeURIComponent(distro)}`, {
        headers: { ...(token && { Authorization: `Bearer ${token}` }) },
    });
    if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch { /* non-JSON error body */ }
        const err = new Error(data.error || data.msg || `Failed to load log (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return res.text();
}
