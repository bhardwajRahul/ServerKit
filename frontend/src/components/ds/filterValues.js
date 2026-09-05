// Count how many filter selections are active — a single-select group counts 1
// when set, a multi-select group counts its selected length. Drives the
// FilterButton badge.
export function countActiveFilters(value = {}) {
    return Object.values(value).reduce((total, entry) => {
        if (Array.isArray(entry)) return total + entry.length;
        return total + (entry ? 1 : 0);
    }, 0);
}

// Empty value object for a given schema — used to clear/initialise state.
export function emptyFilterValue(groups = []) {
    const next = {};
    groups.forEach((group) => { next[group.key] = group.type === 'multi' ? [] : ''; });
    return next;
}
