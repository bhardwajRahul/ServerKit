// Per-domain bandwidth accounting — backs the Services list sparklines and
// the service detail "Bandwidth this month" stat.

export async function getBandwidthApps() {
    return this.request('/bandwidth/apps');
}

export async function getAppBandwidth(appId, days = 90) {
    return this.request(`/bandwidth/apps/${appId}?days=${days}`);
}

export async function runBandwidthAggregate(day = null) {
    return this.request('/bandwidth/aggregate', {
        method: 'POST',
        body: JSON.stringify(day ? { day } : {}),
    });
}
