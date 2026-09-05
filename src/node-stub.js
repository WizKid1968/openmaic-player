/**
 * Browser stub for Node builtins.
 *
 * The scene components import app modules that transitively reach server-only
 * code. Those paths never run in the player, but they must resolve for the
 * bundle to build. Only the handful of functions that could plausibly be
 * touched during module initialisation are real.
 */
export const randomBytes = (n) => {
  const a = new Uint8Array(n);
  (globalThis.crypto || {}).getRandomValues?.(a);
  return a;
};
export const randomUUID = () => (globalThis.crypto || {}).randomUUID?.() ?? '';
export const createHash = () => ({ update() { return this; }, digest: () => '' });
export const isArrayBuffer = (v) => v instanceof ArrayBuffer;
export const isUint8Array = (v) => v instanceof Uint8Array;
export default {};
