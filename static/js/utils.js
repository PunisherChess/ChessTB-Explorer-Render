/**
 * utils.js — Shared helpers
 */

/**
 * Returns a debounced version of fn that fires after `delay` ms of inactivity.
 * The returned function also exposes cancel(), so a caller that's about to
 * issue an equivalent call immediately (bypassing the debounce) can drop any
 * pending trailing call instead of leaving it to fire later against a
 * position that's no longer current.
 * @param {Function} fn
 * @param {number} delay
 */
export function debounce(fn, delay) {
    let timer;
    const debounced = function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
}