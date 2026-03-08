/**
 * TradingService
 *
 * Trading service using official @polymarket/clob-client.
 *
 * Provides:
 * - Order creation (limit, market)
 * - Order management (cancel, query)
 * - Rewards tracking
 * - Balance management
 *
 * Note: Market data methods have been moved to MarketService.
 */

import {
  ClobClient,
  Side as ClobSide,
  OrderType as ClobOrderType,
  Chain,
  type OpenOrder,
  type Trade as ClobTrade,
  type TickSize,
} from '@polymarket/clob-client';

import { Contract, Wallet, ethers } from 'ethers';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import { FailoverProvider, DEFAULT_POLYGON_RPC_URLS } from '../utils/rpc-provider.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { Side, OrderType } from '../core/types.js';

// Chain IDs
export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Polymarket Order Minimums
// ============================================================================
// These are enforced by Polymarket's CLOB API. Orders below these limits will
// be rejected with errors like:
// - "invalid amount for a marketable BUY order ($X), min size: $1"
// - "Size (X) lower than the minimum: 5"
//
// Strategies should ensure orders meet these requirements BEFORE sending.
// ============================================================================

/** Minimum order value in USDC (price * size >= MIN_ORDER_VALUE) */
export const MIN_ORDER_VALUE_USDC = 0.1;

/** Minimum order size in shares */
export const MIN_ORDER_SIZE_SHARES = 5;

// ============================================================================
// Types
// ============================================================================

// Side and OrderType are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, OrderType } from '../core/types.js';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  /** Private key for signing */
  privateKey: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
  /** Pre-generated API credentials (optional) */
  credentials?: ApiCredentials;

  /**
   * Use Polymarket Safe(proxy) wallet as funder.
   * If enabled and funderAddress is not provided, TradingService will compute it via SafeProxyFactory.computeProxyAddress(owner).
   */
  useSafeProxy?: boolean;

  /** Polygon RPC URL, required when useSafeProxy is true and funderAddress is not provided */
  rpcUrl?: string;
  /** List of RPC URLs for failover */
  rpcUrls?: string[];

  /** Override funder address (e.g. Safe(proxy) address) */
  funderAddress?: string;

  /** Signature type for clob-client (2 indicates Gnosis Safe proxy funder in Polymarket docs) */
  signatureType?: number;
}

const SAFE_PROXY_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';
const SAFE_PROXY_FACTORY_ABI = ['function computeProxyAddress(address owner) view returns (address)'];

// Order types
export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
}

export interface Order {
  id: string;
  status: string;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
  /** Actual filled size in shares (for both BUY and SELL) */
  filledSize?: number;
  /** Actual filled amount in USDC (filledSize * price) */
  filledAmount?: number;
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

// Rewards types
export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

// ============================================================================
// TradingService Implementation
// ============================================================================

export class TradingService {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet;
  private chainId: Chain;
  private credentials: ApiCredentials | null = null;
  private initialized = false;
  private tickSizeCache: Map<string, string> = new Map();
  private negRiskCache: Map<string, boolean> = new Map();
  private funderAddress: string | null = null;
  private signatureType: number | null = null;

  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache,
    private config: TradingServiceConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = (config.chainId || POLYGON_MAINNET) as Chain;
    this.credentials = config.credentials || null;
    this.funderAddress = config.funderAddress || null;
    this.signatureType = typeof config.signatureType === 'number' ? config.signatureType : null;
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create CLOB client with L1 auth (wallet)
    this.clobClient = new ClobClient(CLOB_HOST, this.chainId, this.wallet);

    // Get or create API credentials
    // We use derive-first strategy (opposite of official createOrDeriveApiKey)
    // because most users already have a key, avoiding unnecessary 400 error logs.
    if (!this.credentials) {
      const creds = await this.deriveOrCreateApiKey();
      this.credentials = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    }

    // Re-initialize with L2 auth (credentials)
    const creds = {
      key: this.credentials.key,
      secret: this.credentials.secret,
      passphrase: this.credentials.passphrase,
    };

    // If using Safe(proxy) wallet, ensure funder address is set
    if (this.config.useSafeProxy) {
      // Default signatureType for Safe(proxy) in Polymarket docs
      if (this.signatureType === null) this.signatureType = 2;

      if (!this.funderAddress) {
        const rpcUrl = this.config.rpcUrl;
        const rpcUrls = this.config.rpcUrls;
        if (!rpcUrl && !rpcUrls?.length) {
          throw new PolymarketError(
            ErrorCode.INVALID_CONFIG,
            'useSafeProxy is enabled but rpcUrl is missing (needed to compute Safe(proxy) funder address)'
          );
        }
        // Use FailoverProvider if rpcUrls provided, otherwise single rpcUrl
        const provider = rpcUrls?.length
          ? new FailoverProvider({ rpcUrls })
          : new ethers.providers.JsonRpcProvider(rpcUrl);
        const factory = new Contract(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_ABI, provider);
        this.funderAddress = await factory.computeProxyAddress(this.wallet.address);
      }
    }

    // Create L2 client. When signatureType & funder are provided, Polymarket will attribute balances/orders to the funder.
    // We cast to any here to avoid tight coupling to clob-client constructor overloads across versions.
    if (this.signatureType !== null && this.funderAddress) {
      this.clobClient = new (ClobClient as any)(CLOB_HOST, this.chainId, this.wallet, creds, this.signatureType, this.funderAddress);
    } else {
      this.clobClient = new ClobClient(CLOB_HOST, this.chainId, this.wallet, creds);
    }

    this.initialized = true;
  }

  /**
   * Try to derive existing API key first, create new one if not exists.
   * This is the reverse of official createOrDeriveApiKey() to avoid
   * 400 "Could not create api key" error log for existing keys.
   */
  private async deriveOrCreateApiKey(): Promise<{ key: string; secret: string; passphrase: string }> {
    // First try to derive existing key (most common case for existing users)
    // NOTE: Polymarket may respond 400 (throw) when key does not exist.
    try {
      const derived = await this.clobClient!.deriveApiKey();
      if (derived.key) {
        return derived;
      }
    } catch {
      // Fall through to create
    }

    // Create new key (first-time users)
    try {
      const created = await this.clobClient!.createApiKey();
      if (created.key) {
        return created;
      }
    } catch {
      // If create fails (e.g. key already exists), retry derive once.
      try {
        const derivedAgain = await this.clobClient!.deriveApiKey();
        if (derivedAgain.key) {
          return derivedAgain;
        }
      } catch {
        // handled below
      }
    }

    throw new PolymarketError(
      ErrorCode.AUTH_FAILED,
      'Failed to create or derive API key. Wallet may not be registered on Polymarket.'
    );
  }

  private async ensureInitialized(): Promise<ClobClient> {
    if (!this.initialized || !this.clobClient) {
      await this.initialize();
    }
    return this.clobClient!;
  }

  // ============================================================================
  // Trading Helpers
  // ============================================================================

  /**
   * Get tick size for a token
   */
  async getTickSize(tokenId: string): Promise<TickSize> {
    if (this.tickSizeCache.has(tokenId)) {
      return this.tickSizeCache.get(tokenId)! as TickSize;
    }

    const client = await this.ensureInitialized();
    const tickSize = await client.getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, tickSize);
    return tickSize;
  }

  /**
   * Check if token is neg risk
   */
  async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) {
      return this.negRiskCache.get(tokenId)!;
    }

    const client = await this.ensureInitialized();
    const negRisk = await client.getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, negRisk);
    return negRisk;
  }

  // ============================================================================
  // Order Creation
  // ============================================================================

  /**
   * Create and post a limit order
   *
   * Note: Polymarket enforces minimum order value of $1 USDC.
   * Orders below this limit will be rejected.
   */
  async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    // Validate minimum order value ($1) before sending to API
    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;

        const result = await client.createAndPostOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            price: params.price,
            size: params.size,
            expiration: params.expiration || 0,
          },
          { tickSize, negRisk },
          orderType
        );

        const success = result.success === true ||
          (result.success !== false &&
            ((result.orderID !== undefined && result.orderID !== '') ||
              (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

        return {
          success,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg: result.errorMsg,
          transactionHashes: result.transactionsHashes,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  /**
   * Create and post a market order
   *
   * Note: Polymarket enforces minimum order value of $1 USDC.
   * Orders below this limit will be rejected.
   */
  async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    // Validate minimum order requirements before sending to API.
    // BUY uses amount in USDC, SELL uses amount in shares.
    if (params.side === 'BUY') {
      if (params.amount < MIN_ORDER_VALUE_USDC) {
        return {
          success: false,
          errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
        };
      }
    } else {
      // SELL: check dollar value (shares * price)
      const sellValue = params.amount * (params.price ?? 0);
      if (sellValue < MIN_ORDER_VALUE_USDC) {
        return {
          success: false,
          errorMsg: `Order value ($${sellValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
        };
      }
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;

        const result = await client.createAndPostMarketOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            amount: params.amount,
            price: params.price,
          },
          { tickSize, negRisk },
          orderType
        );

        // Preliminary success check based on API response
        // NOTE: Only trust orderID, not transactionsHashes alone (sports markets may return invalid TX hashes)
        const hasOrderId = result.orderID !== undefined && result.orderID !== '';
        const preliminarySuccess = result.success === true || (result.success !== false && hasOrderId);

        // For FOK orders, if success, the entire order is filled
        // For FAK orders, we need to query the order to get actual filled size
        let filledSize: number | undefined;
        let filledAmount: number | undefined;
        let actualSuccess = preliminarySuccess;
        let errorMsg = result.errorMsg;

        // CRITICAL: For FOK/FAK orders, verify actual fill by querying the order
        // An orderID being returned does NOT guarantee the order was filled!
        if (preliminarySuccess && result.orderID) {
          const price = params.price ?? 0;
          try {
            // 移除延迟以加快下单速度，后续有持仓验证兜底
            const orderInfo = await client.getOrder(result.orderID);

            if (orderInfo && orderInfo.size_matched !== undefined) {
              filledSize = Number(orderInfo.size_matched);
              filledAmount = price > 0 ? filledSize * price : 0;

              // For FOK orders: if filledSize is 0 or significantly less than requested, treat as failure
              if (orderType === ClobOrderType.FOK) {
                const requestedSize = params.side === 'BUY' && price > 0
                  ? params.amount / price
                  : params.amount;
                // FOK should be all-or-nothing; if filled less than 90% of requested, consider it failed
                if (!Number.isFinite(filledSize) || filledSize < requestedSize * 0.9) {
                  actualSuccess = false;
                  errorMsg = `FOK order not filled: requested ${requestedSize.toFixed(2)} shares, got ${filledSize?.toFixed(2) ?? 0} (status: ${orderInfo.status || 'unknown'})`;
                }
              } else if (orderType === ClobOrderType.FAK) {
                // For FAK orders: success if any amount was filled
                if (!Number.isFinite(filledSize) || filledSize <= 0) {
                  actualSuccess = false;
                  errorMsg = `FAK order not filled: 0 shares matched (status: ${orderInfo.status || 'unknown'})`;
                }
              }
            } else if (orderInfo === null || orderInfo === undefined) {
              // Order not found in system - for FOK/FAK this typically means:
              // 1. Order was filled and already cleared from active orders
              // 2. Order was rejected/canceled immediately
              // Since we have a valid orderID, lean towards success and let position verification confirm
              console.warn(`[TradingService] Order ${result.orderID} not found in system (likely already filled and cleared)`);

              // For FOK/FAK orders, assume success if we got an orderID - position check will verify
              // This handles sports markets and fast-clearing orders
              const requestedSize = params.side === 'BUY' && price > 0
                ? params.amount / price
                : params.amount;
              filledSize = requestedSize; // Assume full fill, position check will correct
              filledAmount = params.amount;
              // Keep actualSuccess = true, rely on 10-second position verification
            } else {
              // orderInfo exists but no size_matched - check order status
              const status = (orderInfo as any)?.status || '';
              console.warn(`[TradingService] Order ${result.orderID} has no size_matched. Status: ${status}, Full response: ${JSON.stringify(orderInfo).slice(0, 500)}`);

              if (status === 'CANCELED' || status === 'EXPIRED' || status === 'REJECTED') {
                actualSuccess = false;
                errorMsg = `Order ${status.toLowerCase()}: no fills`;
              } else if (status === 'MATCHED' || status === 'FILLED') {
                // Order is matched/filled but size_matched is missing - try to get size from other fields
                const matchedSize = Number((orderInfo as any).matched_amount ?? (orderInfo as any).filledSize ?? (orderInfo as any).original_size ?? 0);
                if (matchedSize > 0) {
                  filledSize = matchedSize;
                  filledAmount = (params.price ?? 0) > 0 ? matchedSize * (params.price ?? 0) : 0;
                } else {
                  // Cannot determine filled size but status is matched - assume success
                  const requestedSize = params.side === 'BUY' && price > 0
                    ? params.amount / price
                    : params.amount;
                  filledSize = requestedSize;
                  filledAmount = params.amount;
                }
              } else {
                // Unknown status (OPEN, PENDING, etc.) - for FAK/FOK this means not filled
                actualSuccess = false;
                errorMsg = `Order not filled: status=${status || 'unknown'} (FAK/FOK orders should be immediately matched or canceled)`;
              }
            }
          } catch (queryError: any) {
            // If query fails, we cannot confirm fill - treat as failure for safety
            // FOK/FAK orders that can't be verified should not be assumed successful
            console.warn(`[TradingService] Could not verify order fill for ${result.orderID}: ${queryError?.message || queryError}`);
            
            // Check if the error indicates the order doesn't exist (likely canceled/expired)
            const errMsg = String(queryError?.message || queryError || '').toLowerCase();
            const orderNotFound = errMsg.includes('not found') || errMsg.includes('does not exist') || errMsg.includes('404');
            
            if (orderNotFound) {
              // Order doesn't exist - likely canceled immediately due to no liquidity
              actualSuccess = false;
              errorMsg = `Order not found (likely canceled due to no liquidity)`;
            } else {
              // Query failed for other reasons - be conservative and mark as unverified
              // For FOK orders, we cannot assume success without verification
              actualSuccess = false;
              errorMsg = `Could not verify order fill: ${queryError?.message || 'query failed'}`;
            }
          }
        }

        // Extract error message from result if not successful
        if (!actualSuccess && !errorMsg) {
          // Try to find error in various result fields
          errorMsg = (result as any).error || (result as any).message || (result as any).reason;
          if (!errorMsg && result.orderID === undefined && result.orderIDs === undefined) {
            // Check if we have TX hashes but no orderID (common in sports markets - unreliable)
            if (result.transactionsHashes?.length > 0) {
              errorMsg = `Order unverified: no orderID returned (TX hashes may be invalid: ${result.transactionsHashes.join(', ')})`;
            } else {
              errorMsg = 'Order rejected (no order ID returned)';
            }
          }
        }

        return {
          success: actualSuccess,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg,
          transactionHashes: result.transactionsHashes,
          filledSize,
          filledAmount,
        };
      } catch (error: any) {
        // Extract error message from various error formats
        let errorMsg = 'Market order failed';
        
        // Check all possible error locations
        const possibleMessages = [
          error?.response?.data?.error,
          error?.response?.data?.message,
          error?.data?.error,
          error?.data?.message,
          error?.error,
          error?.reason,
          error?.message,
        ].filter(Boolean);

        if (possibleMessages.length > 0) {
          errorMsg = possibleMessages[0];
        } else if (typeof error === 'string') {
          errorMsg = error;
        } else {
          // Try to stringify the error for debugging
          try {
            const str = JSON.stringify(error);
            if (str && str !== '{}' && str !== 'null') {
              errorMsg = str.length > 200 ? str.slice(0, 200) + '...' : str;
            }
          } catch {
            errorMsg = String(error) || 'Market order failed';
          }
        }
        
        return {
          success: false,
          errorMsg,
        };
      }
    });
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  async cancelOrder(orderId: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrder({ orderID: orderId });
        return { success: result.canceled ?? false, orderId };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrders(orderIds: string[]): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrders(orderIds);
        return { success: result.canceled ?? false, orderIds };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelAllOrders(): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelAll();
        return { success: result.canceled ?? false };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel all failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async getOpenOrders(marketId?: string): Promise<Order[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const orders = await client.getOpenOrders(marketId ? { market: marketId } : undefined);

      return orders.map((o: OpenOrder) => {
        const originalSize = Number(o.original_size) || 0;
        const filledSize = Number(o.size_matched) || 0;
        return {
          id: o.id,
          status: o.status,
          tokenId: o.asset_id,
          side: o.side.toUpperCase() as Side,
          price: Number(o.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: o.associate_trades || [],
          createdAt: o.created_at,
        };
      });
    });
  }

  async getTrades(marketId?: string): Promise<TradeInfo[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const trades = await client.getTrades(marketId ? { market: marketId } : undefined);

      return trades.map((t: ClobTrade) => ({
        id: t.id,
        tokenId: t.asset_id,
        side: t.side as Side,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        fee: Number(t.fee_rate_bps) || 0,
        timestamp: Number(t.match_time) || Date.now(),
      }));
    });
  }

  // ============================================================================
  // Rewards
  // ============================================================================

  async isOrderScoring(orderId: string): Promise<boolean> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.isOrderScoring({ order_id: orderId });
      return result.scoring;
    });
  }

  async areOrdersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      return await client.areOrdersScoring({ orderIds });
    });
  }

  async getEarningsForDay(date: string): Promise<UserEarning[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const earnings = await client.getEarningsForUserForDay(date);
      return earnings.map(e => ({
        date: e.date,
        conditionId: e.condition_id,
        assetAddress: e.asset_address,
        makerAddress: e.maker_address,
        earnings: e.earnings,
        assetRate: e.asset_rate,
      }));
    });
  }

  async getCurrentRewards(): Promise<MarketReward[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rewards = await client.getCurrentRewards();
      return rewards.map(r => ({
        conditionId: r.condition_id,
        question: r.question,
        marketSlug: r.market_slug,
        eventSlug: r.event_slug,
        rewardsMaxSpread: r.rewards_max_spread,
        rewardsMinSize: r.rewards_min_size,
        tokens: r.tokens.map(t => ({
          tokenId: t.token_id,
          outcome: t.outcome,
          price: t.price,
        })),
        rewardsConfig: r.rewards_config.map(c => ({
          assetAddress: c.asset_address,
          startDate: c.start_date,
          endDate: c.end_date,
          ratePerDay: c.rate_per_day,
          totalRewards: c.total_rewards,
        })),
      }));
    });
  }

  // ============================================================================
  // Balance & Allowance
  // ============================================================================

  private normalizeCollateralAmount(value: string): string {
    // CLOB sometimes returns collateral in base units (micro-USDC). Example: "199962005" -> "199.962005".
    // If it already looks like a decimal, keep as-is.
    const trimmed = String(value ?? '').trim();
    if (trimmed === '' || trimmed.includes('.') || trimmed.toLowerCase().includes('e')) return trimmed;

    // Only normalize when it is a plain integer.
    if (!/^\d+$/.test(trimmed)) return trimmed;

    try {
      return ethers.utils.formatUnits(ethers.BigNumber.from(trimmed), 6);
    } catch {
      return trimmed;
    }
  }

  async getBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<{ balance: string; allowance: string }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.getBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });

      // Normalize collateral to USDC units for display/strategy usage
      if (assetType === 'COLLATERAL') {
        return {
          balance: this.normalizeCollateralAmount(result.balance),
          allowance: this.normalizeCollateralAmount(result.allowance),
        };
      }

      return { balance: result.balance, allowance: result.allowance };
    });
  }

  async updateBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<void> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      await client.updateBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
    });
  }

  // ============================================================================
  // Account Info
  // ============================================================================

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getCredentials(): ApiCredentials | null {
    return this.credentials;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getClobClient(): ClobClient | null {
    return this.clobClient;
  }

  getFunderAddress(): string | null {
    return this.funderAddress;
  }

  getSignatureType(): number | null {
    return this.signatureType;
  }

}
