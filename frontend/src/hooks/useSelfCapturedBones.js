import { useEffect, useRef } from 'react';
import { snapshotBones } from '@/utils/snapshotBones';

// Bump when a wired page's layout changes so cached bones from the old shape are
// discarded instead of replayed. (Runtime self-capture is a best-effort accuracy
// nicety; the composed skeleton is always the fallback.)
export const BONES_CACHE_VERSION = 1;

const keyFor = (key) => `sk-bones:${key}`;

function readCache(key, version) {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(keyFor(key));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed.v !== version || !parsed.snapshot?.bones?.length) {
            localStorage.removeItem(keyFor(key)); // purge stale/mismatched entries
            return null;
        }
        return parsed.snapshot;
    } catch {
        return null;
    }
}

function writeCache(key, version, snapshot) {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(keyFor(key), JSON.stringify({ v: version, snapshot }));
    } catch {
        /* private mode / quota — self-capture is best-effort */
    }
}

/**
 * Runtime self-capture of skeleton bones (Phase 3 of plan 50).
 *
 * After a page's real content has rendered, snapshot the referenced region into
 * bones and cache them in `localStorage` under `sk-bones:<key>`; on the NEXT load
 * those cached bones drive a pixel-accurate skeleton. The first-ever visit has no
 * cache, so `bones` is null and the caller falls back to its composed skeleton —
 * no regression.
 *
 * Usage (the ref must go on the element whose real content should be measured;
 * `SkeletonBoundary` forwards its ref to that container):
 *
 *   const { ref, bones } = useSelfCapturedBones('ssl', { ready: !loading && !!data });
 *   <SkeletonBoundary ref={ref} loading={loading} bones={bones} skeleton={composed}>
 *     {data && <Content />}
 *   </SkeletonBoundary>
 *
 * @param {string} key                Stable cache key (page identifier).
 * @param {object} [opts]
 * @param {boolean} [opts.ready]      True once real content is on screen (capture gate).
 * @param {number}  [opts.version]    Cache version; mismatches are purged.
 * @returns {{ ref: import('react').RefObject<Element>, bones: object|null }}
 */
export function useSelfCapturedBones(key, { ready = false, version = BONES_CACHE_VERSION } = {}) {
    const ref = useRef(null);
    // Read once at mount — this load replays whatever was cached last time.
    const bonesRef = useRef(undefined);
    if (bonesRef.current === undefined) bonesRef.current = readCache(key, version);

    const captured = useRef(false);
    useEffect(() => {
        if (!ready || captured.current || !ref.current) return undefined;
        // Capture after paint so measurements reflect the settled layout.
        const raf = requestAnimationFrame(() => {
            if (!ref.current) return;
            try {
                const snapshot = snapshotBones(ref.current, key);
                if (snapshot?.bones?.length) {
                    writeCache(key, version, snapshot);
                    captured.current = true;
                }
            } catch {
                /* capture is best-effort; never break the page */
            }
        });
        return () => cancelAnimationFrame(raf);
    }, [ready, key, version]);

    return { ref, bones: bonesRef.current };
}

export default useSelfCapturedBones;
