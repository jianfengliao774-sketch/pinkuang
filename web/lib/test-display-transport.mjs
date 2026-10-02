// Test-site public cache GETs only. Wallet actions never use this transport.
export const TEST_DISPLAY_TIMEOUT_MS = 10000;
export async function readTestDisplay(read, {
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  try { return await read(); }
  catch (error) {
    // Retry a dropped/aborted connection once, using the same server cache.
    // Integrity errors and HTTP responses remain the caller's responsibility.
    if (error?.code !== 'network_unavailable') throw error;
    await wait(500);
    return read();
  }
}
