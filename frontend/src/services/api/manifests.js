// Declarative serverkit.yaml manifests (plan/apply/scaffold).
// Mounted by the backend at /api/v1/manifests.

export async function getManifest(projectId) {
    return this.request(`/manifests?project_id=${encodeURIComponent(projectId)}`);
}

export async function planManifest(projectId, body = {}) {
    return this.request('/manifests/plan', {
        method: 'POST',
        body: { project_id: projectId, ...body },
    });
}

export async function applyManifest(projectId, body = {}) {
    return this.request('/manifests/apply', {
        method: 'POST',
        body: { project_id: projectId, ...body },
    });
}

export async function scaffoldManifest(appId) {
    return this.request(`/manifests/scaffold?app_id=${encodeURIComponent(appId)}`);
}
