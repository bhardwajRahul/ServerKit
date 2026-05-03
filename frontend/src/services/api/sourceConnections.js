// Source provider connections

export async function getGithubSourceStatus() {
    return this.request('/source-connections/github/status');
}

export async function startSourceConnection(provider, redirectUri) {
    return this.request(`/source-connections/${provider}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`);
}

export async function completeSourceConnection(provider, code, state, redirectUri) {
    return this.request(`/source-connections/${provider}/callback`, {
        method: 'POST',
        body: { code, state, redirect_uri: redirectUri },
    });
}

export async function disconnectSourceConnection(provider) {
    return this.request(`/source-connections/${provider}`, { method: 'DELETE' });
}

export async function listGithubRepositories({ search = '', page = 1, perPage = 50 } = {}) {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('page', page);
    params.set('per_page', perPage);
    return this.request(`/source-connections/github/repos?${params.toString()}`);
}

export async function listGithubBranches(fullName) {
    return this.request(`/source-connections/github/repos/${encodeURIComponent(fullName)}/branches`);
}

export async function getGithubSourceConfig() {
    return this.request('/source-connections/admin/github');
}

export async function updateGithubSourceConfig(config) {
    return this.request('/source-connections/admin/github', {
        method: 'PUT',
        body: config,
    });
}
