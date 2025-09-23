import { log } from '../logger';
import type { FunctionConfigState, FunctionInstallResult, OpenWebUIFunction } from '../types';
import type { OpenWebUIHttpClient } from './openWebUIHttpClient';

interface InstallFunctionPayload {
  id: string;
  name: string;
  content: string;
  meta?: Record<string, unknown>;
}

export class FunctionsClient {
  private functionsCache?: { value: OpenWebUIFunction[]; cachedAt: number };

  constructor(
    private readonly http: OpenWebUIHttpClient,
    private readonly cacheTtlMs: number,
  ) {}

  clearCache(): void {
    this.functionsCache = undefined;
  }

  async listFunctions(): Promise<OpenWebUIFunction[]> {
    try {
      if (this.functionsCache && Date.now() - this.functionsCache.cachedAt < this.cacheTtlMs) {
        return this.functionsCache.value;
      }

      const result = await this.http.request({
        url: `${this.httpRequestBase()}/functions/export`,
        headers: { 'Content-Type': 'application/json' },
        includeAuth: true,
      });

      const functions = JSON.parse(result);
      const list = Array.isArray(functions)
        ? functions.map((fn) => normalizeFunction(fn as RawOpenWebUIFunction))
        : [];
      this.functionsCache = { value: list, cachedAt: Date.now() };
      return list;
    } catch (error) {
      log.error('Failed to get functions:', error);
      return [];
    }
  }

  async getFunctionById(id: string): Promise<OpenWebUIFunction | null> {
    const functions = await this.listFunctions();
    return functions.find((fn) => fn.id === id) ?? null;
  }

  async isFunctionInstalled(id: string): Promise<boolean> {
    return (await this.getFunctionById(id)) !== null;
  }

  async installFunction(payload: InstallFunctionPayload): Promise<FunctionInstallResult> {
    if (!payload.content || payload.content.trim().length === 0) {
      throw new Error('Function content cannot be empty');
    }

    const requestPayload = JSON.stringify(payload);
    const result = await this.http.request({
      url: `${this.httpRequestBase()}/functions/create`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestPayload,
      includeAuth: true,
    });

    try {
      const parsed = JSON.parse(result);
      const success = parsed?.id === payload.id || parsed?.success === true;
      this.clearCache();
      return {
        success,
        message: success
          ? 'Function installed successfully'
          : 'Function installation response received',
        functionId: payload.id,
      };
    } catch {
      this.clearCache();
      return {
        success: true,
        message: 'Function installed successfully',
        functionId: payload.id,
      };
    }
  }

  isFunctionActive(fn: OpenWebUIFunction | null | undefined): boolean {
    if (!fn) return false;
    return Boolean(fn.isActive ?? fn.config?.isActive ?? fn.config?.enabled);
  }

  async ensureFunctionEnabled(id: string, desired: boolean): Promise<void> {
    let functions = await this.listFunctions();
    let fn = functions.find((item) => item.id === id) ?? null;
    let activation = this.getFunctionActivationState(fn);

    if (activation.local !== desired) {
      await this.toggleFunction(id);
      this.clearCache();
      functions = await this.listFunctions();
      fn = functions.find((item) => item.id === id) ?? null;
      activation = this.getFunctionActivationState(fn);
    }

    if (activation.global !== desired) {
      await this.toggleFunctionGlobal(id);
      this.clearCache();
      functions = await this.listFunctions();
      fn = functions.find((item) => item.id === id) ?? null;
      activation = this.getFunctionActivationState(fn);
    }

    if (activation.local !== desired || activation.global !== desired) {
      log.warn('Function state did not match desired after toggles', {
        desired,
        activation,
      });
    }

    this.clearCache();
  }

  private getFunctionActivationState(fn: OpenWebUIFunction | null | undefined): {
    local: boolean;
    global: boolean;
  } {
    if (!fn) {
      return { local: false, global: false };
    }
    const local = Boolean(fn.isActive ?? fn.config?.isActive ?? fn.config?.enabled);
    const global = Boolean(fn.isGlobal ?? fn.config?.isGlobal);
    return { local, global };
  }

  private async toggleFunction(id: string): Promise<void> {
    log.debug('Toggleing function:', id);
    await this.http.request({
      url: `${this.httpRequestBase()}/functions/id/${id}/toggle`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      includeAuth: true,
    });
  }

  private async toggleFunctionGlobal(id: string): Promise<void> {
    log.debug('Toggleing function globally:', id);
    await this.http.request({
      url: `${this.httpRequestBase()}/functions/id/${id}/toggle/global`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      includeAuth: true,
    });
  }

  private httpRequestBase(): string {
    return this.http.getApiBaseUrl();
  }
}

type RawOpenWebUIFunction = {
  id: string;
  name: string;
  type?: string;
  content?: unknown;
  meta?: unknown;
  isActive?: unknown;
  is_active?: unknown;
  isGlobal?: unknown;
  is_global?: unknown;
  enabled?: unknown;
  is_enabled?: unknown;
  global?: unknown;
  config?: Record<string, unknown> | null;
  [key: string]: unknown;
};

const KNOWN_FUNCTION_TYPES = new Set<OpenWebUIFunction['type']>(['manifold', 'pipe', 'filter']);

const coerceBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

function pickBoolean(source: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const candidate = coerceBoolean(source[key]);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeFunction(raw: RawOpenWebUIFunction): OpenWebUIFunction {
  const configState = normalizeConfig(raw.config);

  const rawRecord = raw as Record<string, unknown>;

  const configActiveCandidate = configState?.isActive ?? configState?.enabled ?? undefined;
  const isActive =
    pickBoolean(rawRecord, ['isActive', 'is_active', 'is_enabled', 'enabled']) ??
    (typeof configActiveCandidate === 'boolean' ? configActiveCandidate : undefined);

  const configGlobalCandidate = configState?.isGlobal ?? undefined;
  const isGlobal =
    pickBoolean(rawRecord, ['isGlobal', 'is_global', 'global']) ??
    (typeof configGlobalCandidate === 'boolean' ? configGlobalCandidate : undefined);

  const typeCandidate = typeof raw.type === 'string' ? raw.type : undefined;
  const normalizedType: OpenWebUIFunction['type'] =
    typeCandidate && KNOWN_FUNCTION_TYPES.has(typeCandidate as OpenWebUIFunction['type'])
      ? (typeCandidate as OpenWebUIFunction['type'])
      : 'pipe';

  const meta =
    raw.meta && typeof raw.meta === 'object' ? (raw.meta as Record<string, unknown>) : null;

  return {
    id: raw.id,
    name: raw.name,
    type: normalizedType,
    content: typeof raw.content === 'string' ? raw.content : undefined,
    meta,
    isActive,
    isGlobal,
    config: configState,
    raw,
  };
}

function normalizeConfig(
  config: Record<string, unknown> | null | undefined,
): FunctionConfigState | null {
  if (!config) {
    return null;
  }

  const state: FunctionConfigState = {};
  const c = config as Record<string, unknown>;

  const active = coerceBoolean(c['isActive']) ?? coerceBoolean(c['is_active']);
  if (active !== undefined) {
    state.isActive = active;
  }

  const global = coerceBoolean(c['isGlobal']) ?? coerceBoolean(c['is_global']);
  if (global !== undefined) {
    state.isGlobal = global;
  }

  const enabled = coerceBoolean(c['enabled']);
  if (enabled !== undefined) {
    state.enabled = enabled;
  }

  return Object.keys(state).length > 0 ? state : null;
}
