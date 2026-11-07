/**
 * storage.js: localStorage helpers
 *
 * Every read/write goes through try/catch, since localStorage can throw in
 * a sandboxed or private-browsing context. A failed or missing read
 * returns null; a failed write is silently ignored - callers treat
 * persistence as best-effort.
 */

export function read(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function write(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* unavailable or full */ }
}

export function readJson(key) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        return parsed === undefined ? null : parsed;
    } catch {
        return null;
    }
}

export function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable or full */ }
}
