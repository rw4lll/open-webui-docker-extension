// Minimal globals for tests
Object.defineProperty(global, 'fetch', {
  writable: true,
  value: async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '' }),
});

// Basic localStorage polyfill
class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

Object.defineProperty(global, 'localStorage', {
  value: new LocalStorageMock(),
});
