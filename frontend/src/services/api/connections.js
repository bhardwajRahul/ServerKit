// Domain-registrar connections — the portfolio + expiry surface that powers the
// Connections → Registrars cards and the Domains-page portfolio.

// Unified, read-only list of every connected external account (source, DNS,
// infra, registrar, storage) — the single "what's connected" source of truth.
export async function getAllConnections() {
    return this.request('/connections');
}

export async function getRegistrarConnections() {
    return this.request('/registrars/connections');
}

export async function addRegistrarConnection(data) {
    return this.request('/registrars/connections', { method: 'POST', body: data });
}

export async function deleteRegistrarConnection(id) {
    return this.request(`/registrars/connections/${id}`, { method: 'DELETE' });
}

export async function testRegistrarConnection(id) {
    return this.request(`/registrars/connections/${id}/test`, { method: 'POST' });
}

export async function getRegistrarDomains() {
    return this.request('/registrars/domains');
}

export async function syncRegistrarDomains() {
    return this.request('/registrars/sync', { method: 'POST' });
}
