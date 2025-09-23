import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useState } from 'react';

interface AsyncFeedbackOptions {
  errorPrefix?: string;
  preserveMessage?: boolean;
}

interface AsyncFeedback {
  loading: boolean;
  message: string | null;
  error: string | null;
  setMessage: Dispatch<SetStateAction<string | null>>;
  clearMessage: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
  clearError: () => void;
  runAsync: <T>(fn: () => Promise<T>, options?: AsyncFeedbackOptions) => Promise<T | undefined>;
}

export function useAsyncFeedback(): AsyncFeedback {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearMessage = useCallback(() => setMessage(null), []);
  const clearError = useCallback(() => setError(null), []);

  const runAsync = useCallback(
    async <T>(fn: () => Promise<T>, options?: AsyncFeedbackOptions): Promise<T | undefined> => {
      setLoading(true);
      clearError();
      if (!options?.preserveMessage) {
        clearMessage();
      }

      try {
        const result = await fn();
        return result;
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const finalMessage = options?.errorPrefix
          ? `${options.errorPrefix}: ${rawMessage}`
          : rawMessage;
        setError(finalMessage);
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [clearError, clearMessage],
  );

  return {
    loading,
    message,
    error,
    setMessage,
    clearMessage,
    setError,
    clearError,
    runAsync,
  };
}
