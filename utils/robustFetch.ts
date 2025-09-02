/**
 * Robust fetch utility with retry logic, timeout handling, and error logging.
 * Provides improved reliability for network requests.
 */

interface RobustFetchOptions {
  maxRetries?: number;
  timeout?: number;
  retryDelay?: number;
  backoffMultiplier?: number;
}

interface FetchResult {
  response: Response;
  data: string;
}

/**
 * Performs a robust fetch request with retry logic and timeout handling.
 * 
 * @param url - The URL to fetch
 * @param options - Fetch options (method, headers, body, etc.)
 * @param robustOptions - Configuration for retry logic and timeout
 * @returns Promise resolving to Response object or throwing an error
 */
export const robustFetch = async (
  url: string,
  options: RequestInit = {},
  robustOptions: RobustFetchOptions = {}
): Promise<Response> => {
  const {
    maxRetries = 3,
    timeout = 10000, // 10 seconds
    retryDelay = 1000, // 1 second initial delay
    backoffMultiplier = 2
  } = robustOptions;

  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempting fetch to ${url} (attempt ${attempt + 1}/${maxRetries + 1})`);
      
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      // Perform the fetch with timeout
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      // Clear timeout if request completed
      clearTimeout(timeoutId);
      
      // Check if response is successful (2xx status codes)
      if (response.ok) {
        console.log(`Successful fetch to ${url} on attempt ${attempt + 1}`);
        return response;
      }
      
      // Log non-200 response and prepare for retry
      const errorMsg = `HTTP ${response.status}: ${response.statusText}`;
      console.warn(`Non-200 response from ${url}: ${errorMsg} (attempt ${attempt + 1})`);
      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
      
      // Don't retry on certain status codes that won't benefit from retries
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        console.error(`Client error ${response.status} from ${url}, not retrying`);
        throw lastError;
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`Fetch attempt ${attempt + 1} failed for ${url}: ${errorMsg}`);
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Handle AbortError (timeout)
      if (error instanceof Error && error.name === 'AbortError') {
        console.warn(`Request to ${url} timed out after ${timeout}ms (attempt ${attempt + 1})`);
        lastError = new Error(`Request timeout after ${timeout}ms`);
      }
    }
    
    // If this wasn't the last attempt, wait before retrying
    if (attempt < maxRetries) {
      const delay = retryDelay * Math.pow(backoffMultiplier, attempt);
      console.log(`Waiting ${delay}ms before retry for ${url}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // All retries exhausted
  console.error(`All ${maxRetries + 1} attempts failed for ${url}. Final error: ${lastError.message}`);
  throw lastError;
};

/**
 * Robust fetch that returns both response and text data.
 * Useful for endpoints that need the response body as text.
 * 
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @param robustOptions - Configuration for retry logic and timeout
 * @returns Promise resolving to object with response and text data
 */
export const robustFetchText = async (
  url: string,
  options: RequestInit = {},
  robustOptions: RobustFetchOptions = {}
): Promise<FetchResult> => {
  const response = await robustFetch(url, options, robustOptions);
  const data = await response.text();
  return { response, data };
};

/**
 * Robust fetch that returns both response and JSON data.
 * Useful for JSON endpoints.
 * 
 * @param url - The URL to fetch
 * @param options - Fetch options  
 * @param robustOptions - Configuration for retry logic and timeout
 * @returns Promise resolving to object with response and JSON data
 */
export const robustFetchJson = async (
  url: string,
  options: RequestInit = {},
  robustOptions: RobustFetchOptions = {}
): Promise<{ response: Response; data: any }> => {
  const response = await robustFetch(url, options, robustOptions);
  const data = await response.json();
  return { response, data };
};