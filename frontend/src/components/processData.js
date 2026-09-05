// The process API uses both user and username across local/remote collectors.
export const procUser = (p) => p.user || p.username || '';
