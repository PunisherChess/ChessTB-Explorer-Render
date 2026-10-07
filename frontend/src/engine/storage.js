/**
 * storage.js: localStorage helpers
 *
 * Every read/write goes through try/catch, since localStorage can throw in
 * a sandboxed or private-browsing context. A failed read returns `fallback`;
 * a failed write is silently ignored - callers treat persistence as
 * best-effort.
 */

export function read(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : raw;
    } catch (_) {
        return fallback;
    }
}

export function write(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (_) { /* unavailable or full */ }
}

export function readJson(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (_) {
        return fallback;
    }
}

export function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* unavailable or full */ }
}
