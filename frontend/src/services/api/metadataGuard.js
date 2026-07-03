// Cloud metadata guard API — egress block for the cloud metadata endpoint.

export async function getMetadataGuard() {
    return this.request('/firewall/metadata-guard');
}

export async function setMetadataGuard(enabled) {
    return this.request('/firewall/metadata-guard', {
        method: 'PUT',
        body: { enabled }
    });
}
