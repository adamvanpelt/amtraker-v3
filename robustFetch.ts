/**
 * Robust fetch function with automatic retries, timeouts, and consistent error handling
 * Implements exponential backoff strategy for resilient data fetching
 */

export async function robustFetch(
  url: string,
  options: RequestInit = {},
  retries = 3,
  timeoutMs = 10000
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        return res;
      } else {
        console.warn(`Fetch failed (attempt ${attempt + 1}): ${res.status} ${res.statusText} for ${url}`);
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        console.warn(`Fetch timed out (attempt ${attempt + 1}): ${url}`);
      } else {
        console.warn(`Fetch error (attempt ${attempt + 1}) for ${url}:`, err.message || err);
      }
    }

    // Don't wait after the last attempt
    if (attempt < retries - 1) {
      // Exponential backoff before retrying
      const backoffMs = 500 * Math.pow(2, attempt);
      console.warn(`Retrying in ${backoffMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}