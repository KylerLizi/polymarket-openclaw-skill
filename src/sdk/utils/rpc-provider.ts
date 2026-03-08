/**
 * Failover RPC Provider
 *
 * Provides automatic RPC failover when a request fails.
 * Cycles through a list of RPC URLs and retries failed requests.
 */

import { ethers } from 'ethers';

// Default Polygon RPC URLs (ordered by reliability)
export const DEFAULT_POLYGON_RPC_URLS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
  'https://polygon-mainnet.public.blastapi.io',
  'https://polygon.drpc.org',
  'https://1rpc.io/matic',
  'https://polygon-bor-rpc.publicnode.com',
];

export interface FailoverProviderConfig {
  /** List of RPC URLs to use (in order of preference) */
  rpcUrls?: string[];
  /** Maximum number of retries per request (default: 3) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 500) */
  retryDelay?: number;
  /** Timeout for each RPC request in ms (default: 10000) */
  timeout?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

/**
 * Creates a failover JSON-RPC provider that automatically switches
 * to backup RPCs when the current one fails.
 * 
 * Uses direct fetch calls instead of modifying base class properties.
 */
export class FailoverProvider extends ethers.providers.StaticJsonRpcProvider {
  private rpcUrls: string[];
  private currentIndex: number = 0;
  private maxRetries: number;
  private retryDelay: number;
  private timeout: number;
  private debugMode: boolean;
  private failureCount: Map<string, number> = new Map();
  private requestId: number = 1;

  constructor(config: FailoverProviderConfig = {}) {
    const rpcUrls = config.rpcUrls?.length ? config.rpcUrls : DEFAULT_POLYGON_RPC_URLS;
    // Pass network config to skip initial detectNetwork call
    super(rpcUrls[0], { chainId: 137, name: 'matic' });

    this.rpcUrls = rpcUrls;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 500;
    this.timeout = config.timeout ?? 10000;
    this.debugMode = config.debug ?? false;
  }

  private log(message: string): void {
    if (this.debugMode) {
      console.log(`[FailoverProvider] ${message}`);
    }
  }

  /**
   * Get the current RPC URL being used
   */
  getCurrentRpcUrl(): string {
    return this.rpcUrls[this.currentIndex];
  }

  /**
   * Get all configured RPC URLs
   */
  getRpcUrls(): string[] {
    return [...this.rpcUrls];
  }

  /**
   * Switch to the next RPC URL in the list
   */
  private switchToNextRpc(): void {
    const prevUrl = this.rpcUrls[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.rpcUrls.length;
    const newUrl = this.rpcUrls[this.currentIndex];
    this.log(`Switched RPC: ${prevUrl} -> ${newUrl}`);
  }

  /**
   * Record a failure for the current RPC
   */
  private recordFailure(): void {
    const url = this.getCurrentRpcUrl();
    const count = (this.failureCount.get(url) || 0) + 1;
    this.failureCount.set(url, count);
    this.log(`RPC failure recorded for ${url} (total: ${count})`);
  }

  /**
   * Reset failure count for an RPC (called on success)
   */
  private resetFailure(): void {
    const url = this.getCurrentRpcUrl();
    if (this.failureCount.has(url)) {
      this.failureCount.delete(url);
    }
  }

  /**
   * Direct JSON-RPC call to a specific URL
   */
  private async directRpcCall(url: string, method: string, params: any[]): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.requestId++,
          method,
          params,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      
      if (json.error) {
        const err = new Error(json.error.message || 'RPC Error');
        (err as any).code = json.error.code;
        throw err;
      }

      return json.result;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`RPC request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Override send to add failover logic
   */
  async send(method: string, params: Array<any>): Promise<any> {
    let lastError: Error | null = null;
    const startIndex = this.currentIndex;
    let attempts = 0;
    const maxAttempts = this.maxRetries * this.rpcUrls.length;

    while (attempts < maxAttempts) {
      const currentUrl = this.getCurrentRpcUrl();
      
      try {
        const result = await this.directRpcCall(currentUrl, method, params);
        this.resetFailure();
        return result;
      } catch (error: any) {
        lastError = error;
        this.recordFailure();

        const errorMsg = error?.message || String(error);
        this.log(`RPC error on ${currentUrl}: ${errorMsg.slice(0, 100)}`);

        // Only non-retryable errors (contract revert, bad params) should fail fast
        if (this.isNonRetryableError(error)) {
          throw error;
        }

        // All other errors: switch to next RPC and retry
        this.switchToNextRpc();

        // If we've cycled through all RPCs, wait before retrying
        if (this.currentIndex === startIndex) {
          this.log(`All RPCs failed, waiting ${this.retryDelay}ms before retry...`);
          await this.delay(this.retryDelay);
        }

        attempts++;
      }
    }

    throw lastError || new Error('All RPC endpoints failed');
  }

  /**
   * Check if error is a non-retryable business logic error (contract revert, bad params).
   * Everything else (network errors, HTTP 5xx, rate limits, timeouts, etc.) is retryable.
   */
  private isNonRetryableError(error: any): boolean {
    const msg = (error?.message || '').toLowerCase();
    const code = error?.code;

    // EVM revert / call exception — definitely a contract-level error
    if (code === 'CALL_EXCEPTION' || code === 'UNPREDICTABLE_GAS_LIMIT') return true;

    // JSON-RPC error codes for invalid request / method not found
    if (code === -32600 || code === -32601 || code === -32602) return true;

    // Explicit revert / require messages
    if (msg.includes('execution reverted') || msg.includes('revert')) return true;

    // Everything else is retryable (network errors, HTTP 5xx, rate limits, timeouts, etc.)
    return false;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get statistics about RPC failures
   */
  getStats(): { url: string; failures: number }[] {
    return this.rpcUrls.map(url => ({
      url,
      failures: this.failureCount.get(url) || 0,
    }));
  }
}

/**
 * Create a failover provider with default or custom RPC URLs
 */
export function createFailoverProvider(config?: FailoverProviderConfig): FailoverProvider {
  return new FailoverProvider(config);
}

/**
 * Create a standard JsonRpcProvider with a single RPC URL
 * Falls back to the first default RPC if not provided
 */
export function createProvider(rpcUrl?: string): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(rpcUrl || DEFAULT_POLYGON_RPC_URLS[0]);
}
