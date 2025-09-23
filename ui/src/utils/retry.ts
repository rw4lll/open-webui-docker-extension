export interface RetryOptions {
  maxAttempts?: number;
  delays?: number[];
  errorFactory?: (lastError: unknown, attempts: number) => Error;
}

export interface BackoffDelaysOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  maxCumulativeDelayMs?: number;
  factor?: number;
}

function toPositiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(Number(value));
  return integer > 0 ? integer : undefined;
}

function toPositiveNumber(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const numeric = Number(value);
  return numeric > 0 ? numeric : undefined;
}

export function buildBackoffDelays(options: BackoffDelaysOptions = {}): number[] {
  const initialProvided = options.initialDelayMs;
  const normalizedInitial = toPositiveNumber(initialProvided);
  const initialDelay = normalizedInitial ?? (initialProvided === undefined ? 1000 : undefined);

  if (initialDelay === undefined) {
    return [];
  }

  const normalizedMaxDelay = toPositiveNumber(options.maxDelayMs);
  const maxDelay = normalizedMaxDelay ?? initialDelay;
  const factor = toPositiveNumber(options.factor) ?? 2;
  const maxAttempts = toPositiveInteger(options.maxAttempts);
  const maxCumulative = toPositiveNumber(options.maxCumulativeDelayMs);

  const delays: number[] = [];
  let currentDelay = Math.min(initialDelay, maxDelay);
  let cumulativeDelay = 0;

  const hasAttemptLimit = typeof maxAttempts === 'number';
  const hasCumulativeLimit = typeof maxCumulative === 'number';

  // Provide a safe upper bound so we never loop forever if limits are missing or invalid.
  const fallbackLimit = hasAttemptLimit || hasCumulativeLimit ? Number.MAX_SAFE_INTEGER : 10;

  while (delays.length < fallbackLimit) {
    if (hasAttemptLimit && delays.length >= (maxAttempts as number)) {
      break;
    }

    if (hasCumulativeLimit && cumulativeDelay + currentDelay > (maxCumulative as number)) {
      break;
    }

    delays.push(currentDelay);
    cumulativeDelay += currentDelay;

    if (hasAttemptLimit && delays.length >= (maxAttempts as number)) {
      break;
    }

    if (hasCumulativeLimit && cumulativeDelay >= (maxCumulative as number)) {
      break;
    }

    const next = currentDelay * factor;
    const normalizedNext = toPositiveNumber(next) ?? currentDelay;
    currentDelay = Math.min(normalizedNext, maxDelay);

    if (!Number.isFinite(currentDelay) || currentDelay <= 0) {
      break;
    }

    if (!hasAttemptLimit && !hasCumulativeLimit && currentDelay === delays[delays.length - 1]) {
      break;
    }
  }

  return delays;
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  { maxAttempts, delays = [], errorFactory }: RetryOptions = {},
): Promise<T> {
  const normalizedDelays = delays.filter((value) => Number.isFinite(value) && value > 0);
  const attemptsFromDelays = normalizedDelays.length > 0 ? normalizedDelays.length + 1 : 1;
  const attempts = Math.max(1, maxAttempts ?? attemptsFromDelays);

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) {
        break;
      }

      const delayMs =
        normalizedDelays[Math.min(attempt, Math.max(0, normalizedDelays.length - 1))] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  if (errorFactory) {
    throw errorFactory(lastError, attempts);
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError));
}
