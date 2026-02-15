import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IMAGE_UPDATE_FLOATING_TAG_REGEX, IMAGE_UPDATE_POLL_INTERVAL_MS } from '../constants';
import { log } from '../logger';
import { createImageUpdateSignature, defaultImageUpdateCache } from '../services/imageUpdateCache';
import type { ContainerService } from '../services/containerService';
import type { ContainerStatus, ExtensionConfig, ImageUpdateCheckResult } from '../types';
import { toErrorMessage } from '../utils/dockerCliError';

interface UseImageUpdateCheckOptions {
  pollIntervalMs?: number;
}

interface CheckNowOptions {
  force?: boolean;
}

interface UseImageUpdateCheckResult {
  imageUpdate: ImageUpdateCheckResult | null;
  checking: boolean;
  checkNow: (options?: CheckNowOptions) => Promise<ImageUpdateCheckResult | null>;
  clearCachedUpdate: () => void;
}

function createUnsupportedResult(image: string): ImageUpdateCheckResult {
  return {
    image,
    supported: false,
    updateAvailable: false,
    checkedAt: Date.now(),
  };
}

export function useImageUpdateCheck(
  config: ExtensionConfig,
  status: ContainerStatus | null,
  options: UseImageUpdateCheckOptions = {},
  service: ContainerService,
): UseImageUpdateCheckResult {
  const imageSignature = useMemo(() => createImageUpdateSignature(config.image), [config.image]);
  const pollIntervalMs = options.pollIntervalMs ?? IMAGE_UPDATE_POLL_INTERVAL_MS;

  const [imageUpdate, setImageUpdate] = useState<ImageUpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<ImageUpdateCheckResult | null> | null>(null);
  const initialCheckedSignatureRef = useRef<string | null>(null);
  const enteredRunningRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearCachedUpdate = useCallback(() => {
    defaultImageUpdateCache.clear();
    setImageUpdate(null);
  }, []);

  const checkNow = useCallback(
    async ({ force = false }: CheckNowOptions = {}): Promise<ImageUpdateCheckResult | null> => {
      const trimmedImage = config.image.trim();

      if (!trimmedImage || !IMAGE_UPDATE_FLOATING_TAG_REGEX.test(trimmedImage)) {
        const unsupported = createUnsupportedResult(trimmedImage);
        if (mountedRef.current) {
          setImageUpdate(unsupported);
          setChecking(false);
        }
        return unsupported;
      }

      if (inFlightRef.current) {
        if (!force) {
          return inFlightRef.current;
        }

        // For forced refresh, wait for any in-flight check to settle,
        // then run a fresh check against the latest image state.
        try {
          await inFlightRef.current;
        } catch {
          // Ignore failures from the previous run; force path should continue.
        }
      }

      if (!force) {
        const cached = defaultImageUpdateCache.get(imageSignature);
        if (cached) {
          if (mountedRef.current) {
            setImageUpdate(cached.result);
            setChecking(false);
          }
          return cached.result;
        }
      }

      const run = async (): Promise<ImageUpdateCheckResult | null> => {
        if (mountedRef.current) {
          setChecking(true);
        }

        try {
          const result = await service.checkImageUpdateAvailability(trimmedImage);
          defaultImageUpdateCache.set({
            result,
            imageSignature,
            checkedAt: result.checkedAt,
          });
          if (mountedRef.current) {
            setImageUpdate(result);
          }
          return result;
        } catch (error) {
          log.warn('Image update check failed:', error);
          const failedResult: ImageUpdateCheckResult = {
            image: trimmedImage,
            supported: true,
            updateAvailable: false,
            checkedAt: Date.now(),
            error: `Failed to check image updates: ${toErrorMessage(error)}`,
          };
          defaultImageUpdateCache.set({
            result: failedResult,
            imageSignature,
            checkedAt: failedResult.checkedAt,
          });
          if (mountedRef.current) {
            setImageUpdate(failedResult);
          }
          return failedResult;
        } finally {
          if (mountedRef.current) {
            setChecking(false);
          }
        }
      };

      const inFlightPromise = run().finally(() => {
        if (inFlightRef.current === inFlightPromise) {
          inFlightRef.current = null;
        }
      });
      inFlightRef.current = inFlightPromise;
      return inFlightPromise;
    },
    [config.image, imageSignature, service],
  );

  useEffect(() => {
    if (!status) {
      return;
    }

    if (status.status === 'running') {
      return;
    }

    if (initialCheckedSignatureRef.current === imageSignature) {
      return;
    }

    initialCheckedSignatureRef.current = imageSignature;
    void checkNow();
  }, [checkNow, imageSignature, status]);

  useEffect(() => {
    const running = status?.status === 'running';

    if (!running) {
      enteredRunningRef.current = false;
      return;
    }

    if (!enteredRunningRef.current) {
      enteredRunningRef.current = true;
      void checkNow({ force: true });
    }

    const intervalId = setInterval(() => {
      void checkNow();
    }, pollIntervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [checkNow, pollIntervalMs, status?.status]);

  return {
    imageUpdate,
    checking,
    checkNow,
    clearCachedUpdate,
  };
}
