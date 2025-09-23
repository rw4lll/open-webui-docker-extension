// Simple logging utility for Open WebUI Docker Extension
// Vite automatically strips console.log() and console.info() in production builds

export const log = {
  // Debug logs - automatically stripped in production
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),

  // Info logs - kept in production for important operational messages
  info: (...args: unknown[]) => console.info('[INFO]', ...args),

  // Warning logs - kept in production for debugging
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),

  // Error logs - kept in production for debugging
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
};
