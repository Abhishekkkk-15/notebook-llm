interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number; // e.g., 2000 for 2 seconds
  backoffFactor?: number; // multiplier, default 2 (2s -> 4s -> 8s)
  maxDelayMs?: number; // ceiling cap to prevent indefinite waits
}
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 5,
    initialDelayMs = 2000,
    backoffFactor = 2,
    maxDelayMs = 30000,
  } = options;

  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      // Detect rate-limit (LangChain / OpenAI SDK / Axios / fetch formats)
      const isRateLimit =
        error?.status === 429 ||
        error?.statusCode === 429 ||
        error?.response?.status === 429 ||
        error?.code === "rate_limit_exceeded";

      if (!isRateLimit || attempt === maxRetries) {
        throw error;
      }

      // Check for a standard "Retry-After" header in the response (seconds or ms)
      const retryAfterHeader =
        error?.response?.headers?.["retry-after"] ??
        error?.headers?.get?.("retry-after");

      let waitTime = delay;
      if (retryAfterHeader) {
        const parsedSeconds = Number(retryAfterHeader);
        if (!isNaN(parsedSeconds)) {
          waitTime = parsedSeconds * 1000;
        }
      }

      // Add a slight random jitter (0-200ms) to avoid thundering herd issues
      const jitter = Math.floor(Math.random() * 200);
      const totalWait = Math.min(waitTime + jitter, maxDelayMs);

      console.warn(
        `[Rate Limit 429] Retrying in ${totalWait}ms (Attempt ${attempt}/${maxRetries})...`,
      );

      await new Promise((resolve) => setTimeout(resolve, totalWait));

      // Calculate the next exponential delay
      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }

  throw new Error("Exceeded maximum retries for rate limit.");
}

export function RateLimitRetry(options: RetryOptions = {}) {
  return function (
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Preserve `this` binding by calling originalMethod.apply(this, args)
      return withRateLimitRetry(
        () => originalMethod.apply(this, args),
        options,
      );
    };

    return descriptor;
  };
}
