import type { WalletService } from './wallet-service.js';
import { TradingService, type OrderResult } from './trading-service.js';
import type { RateLimiter } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import type { SmartMoneyTrade } from './smart-money-service.js';

export interface MultiAccountExecutorConfig {
  chainId?: number;
  useSafeProxy?: boolean;
  rpcUrl?: string;
  rpcUrls?: string[];
  signatureType?: number;
  funderAddress?: string;

  minEligibleCollateralUsdc?: number;
  refreshIntervalMs?: number;

  minWalletsPerTrade?: number;
  maxWalletsPerTrade?: number;

  sizeScale?: number;
  maxSizePerTrade?: number;
  maxSlippage?: number;
  orderType?: 'FOK' | 'FAK';
  minTradeSize?: number;

  allowDuplicateBuys?: boolean;

  /** 钱包空闲天数阈值，优先选择超过此天数未交易的钱包（默认 3 天） */
  idleDaysThreshold?: number;
}

export interface EligibleWalletInfo {
  index: number;
  ownerAddress: string;
  funderAddress: string | null;
  myAddress: string;
  collateralUsdc: number;
  tradingService: TradingService;
}

export interface MultiAccountTradeResult {
  selectedWallets: EligibleWalletInfo[];
  perWalletResults: Array<{
    wallet: EligibleWalletInfo;
    result: OrderResult;
  }>;
  /** Requested size per wallet (after sizeScale and maxSizePerTrade limits) */
  requestedPerWalletSize?: number;
  /** Requested value per wallet in USDC (after sizeScale and maxSizePerTrade limits) */
  requestedPerWalletValue?: number;
}

function clampPrice(price: number): number {
  const MIN = 0.001;
  const MAX = 0.999;
  const safe = Math.min(MAX, Math.max(MIN, price));
  return Number.parseFloat(safe.toFixed(6));
}

// 判断是否为可重试的错误
function isRetryableError(error: any): boolean {
  const msg = String(error?.message || error?.error || error || '').toLowerCase();
  const status = Number(error?.status || error?.response?.status);

  // HTTP 状态码
  if ([429, 500, 502, 503, 504].includes(status)) return true;

  // 常见可重试错误
  if (msg.includes('rate limit') || msg.includes('too many requests')) return true;
  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  if (msg.includes('econnreset') || msg.includes('socket hang up')) return true;
  if (msg.includes('econnrefused') || msg.includes('network')) return true;
  if (msg.includes('bad gateway') || msg.includes('service unavailable')) return true;
  if (msg.includes('temporarily unavailable')) return true;
  if (msg.includes('internal server error')) return true;

  return false;
}

// 带重试的异步函数执行
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (error: any, attempt: number) => void;
  } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 10000, onRetry } = options;

  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      // 指数退避 + 随机抖动
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        maxDelayMs
      );

      if (onRetry) {
        onRetry(error, attempt);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function getRandomIntInclusive(min: number, max: number): number {
  const mn = Math.ceil(min);
  const mx = Math.floor(max);
  return Math.floor(Math.random() * (mx - mn + 1)) + mn;
}

function sampleWithoutReplacement<T>(arr: T[], k: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, Math.min(k, copy.length)));
}

/**
 * 并发限制器：限制同时执行的 Promise 数量
 * @param concurrency 最大并发数
 */
function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      const fn = queue.shift()!;
      fn();
    }
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    activeCount++;
    try {
      return await fn();
    } finally {
      next();
    }
  };

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const runTask = () => {
        run(fn).then(resolve, reject);
      };

      if (activeCount < concurrency) {
        runTask();
      } else {
        queue.push(runTask);
      }
    });
  };

  return enqueue;
}

export class MultiAccountExecutor {
  private walletService: WalletService;
  private rateLimiter: RateLimiter;
  private cache: UnifiedCache;
  private config: Required<MultiAccountExecutorConfig>;

  private tradingServices: TradingService[];
  private walletIndices: number[];
  private eligibleWallets: EligibleWalletInfo[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private positionsCache: Map<string, { at: number; positions: any[] }> = new Map();
  /** 每个钱包的最近交易时间 (walletIndex -> timestamp ms) */
  private lastTradeTimeMap: Map<number, number> = new Map();

  constructor(params: {
    walletService: WalletService;
    rateLimiter: RateLimiter;
    cache: UnifiedCache;
    privateKeys: string[];
    /** Original wallet indices from mnemonic derivation (e.g., [1,2,3,4,5] for range "1-5") */
    walletIndices?: number[];
    config?: MultiAccountExecutorConfig;
  }) {
    this.walletService = params.walletService;
    this.rateLimiter = params.rateLimiter;
    this.cache = params.cache;

    this.config = {
      chainId: params.config?.chainId ?? 137,
      useSafeProxy: params.config?.useSafeProxy ?? false,
      rpcUrl: params.config?.rpcUrl,
      rpcUrls: params.config?.rpcUrls,
      signatureType: params.config?.signatureType,
      funderAddress: params.config?.funderAddress,

      minEligibleCollateralUsdc: params.config?.minEligibleCollateralUsdc ?? 10,
      refreshIntervalMs: params.config?.refreshIntervalMs ?? 10 * 60 * 1000,

      minWalletsPerTrade: params.config?.minWalletsPerTrade ?? 1,
      maxWalletsPerTrade: params.config?.maxWalletsPerTrade ?? 3,

      sizeScale: params.config?.sizeScale ?? 0.1,
      maxSizePerTrade: params.config?.maxSizePerTrade ?? 50,
      maxSlippage: params.config?.maxSlippage ?? 0.03,
      orderType: params.config?.orderType ?? 'FOK',
      minTradeSize: params.config?.minTradeSize ?? 10,

      allowDuplicateBuys: params.config?.allowDuplicateBuys ?? false,
      idleDaysThreshold: params.config?.idleDaysThreshold ?? 3,
    };

    // Store original wallet indices (from mnemonic derivation) or default to 0-based array indices
    this.walletIndices = params.walletIndices ?? params.privateKeys.map((_, i) => i);

    this.tradingServices = params.privateKeys.map(pk =>
      new TradingService(this.rateLimiter, this.cache, {
        privateKey: pk,
        chainId: this.config.chainId,
        useSafeProxy: this.config.useSafeProxy,
        rpcUrl: this.config.rpcUrl,
        rpcUrls: this.config.rpcUrls,
        signatureType: this.config.signatureType,
        funderAddress: this.config.funderAddress,
      })
    );
  }

  getEligibleWallets(): EligibleWalletInfo[] {
    return this.eligibleWallets.slice();
  }

  /** 获取钱包最近交易时间 */
  getLastTradeTime(walletIndex: number): number | undefined {
    return this.lastTradeTimeMap.get(walletIndex);
  }

  /** 手动更新钱包最近交易时间 */
  updateLastTradeTime(walletIndex: number, timestamp?: number): void {
    this.lastTradeTimeMap.set(walletIndex, timestamp ?? Date.now());
  }

  /**
   * 初始化每个钱包的最近交易时间（从链上活动记录获取）
   * 应在 refreshEligibleWallets 之后调用
   */
  async initializeLastTradeTimes(): Promise<void> {
    const CONCURRENCY = 5;
    const limit = pLimit(CONCURRENCY);

    const tasks = this.tradingServices.map((ts, i) =>
      limit(async () => {
        const walletIndex = this.walletIndices[i] ?? i;
        try {
          await ts.initialize();
          const { my } = this.getMyAddress(ts);
          // 获取最近 1 条 TRADE 类型活动
          const result = await withRetry(
            () => this.walletService.getWalletActivity(my, { limit: 1, type: 'TRADE' }),
            { maxRetries: 2, baseDelayMs: 500 }
          ).catch(() => null);

          const activities = result?.activities;
          if (activities && activities.length > 0 && activities[0].timestamp > 0) {
            // Activity timestamp 可能是秒级或毫秒级，统一转为毫秒
            const actTs = activities[0].timestamp > 1e12 ? activities[0].timestamp : activities[0].timestamp * 1000;
            this.lastTradeTimeMap.set(walletIndex, actTs);
          }
          // 没有交易记录的钱包不设置，被视为"从未交易"，将被优先选中
        } catch {
          // 初始化失败的钱包不设置
        }
      })
    );

    await Promise.all(tasks);

    // 日志输出
    const now = Date.now();
    const idleMs = this.config.idleDaysThreshold * 24 * 60 * 60 * 1000;
    let idleCount = 0;
    let activeCount = 0;
    for (const idx of this.walletIndices) {
      const lastTime = this.lastTradeTimeMap.get(idx);
      if (!lastTime || now - lastTime >= idleMs) {
        idleCount++;
      } else {
        activeCount++;
      }
    }
    console.log(
      `[MultiExecutor] 钱包交易时间初始化完成: 空闲(≥${this.config.idleDaysThreshold}天)=${idleCount}, 活跃(<${this.config.idleDaysThreshold}天)=${activeCount}`
    );
  }

  /**
   * 优先选择空闲钱包的采样逻辑
   * 1. 从空闲钱包（超过 idleDaysThreshold 天未交易）中随机选
   * 2. 如果空闲钱包不够，剩余名额从活跃钱包中随机选
   */
  private sampleWithIdlePriority(pool: EligibleWalletInfo[], pickN: number): EligibleWalletInfo[] {
    const now = Date.now();
    const idleMs = this.config.idleDaysThreshold * 24 * 60 * 60 * 1000;

    const idleWallets: EligibleWalletInfo[] = [];
    const activeWallets: EligibleWalletInfo[] = [];

    for (const w of pool) {
      const lastTime = this.lastTradeTimeMap.get(w.index);
      if (!lastTime || now - lastTime >= idleMs) {
        idleWallets.push(w);
      } else {
        activeWallets.push(w);
      }
    }

    // 先从空闲钱包中随机选
    const fromIdle = sampleWithoutReplacement(idleWallets, Math.min(pickN, idleWallets.length));
    const remaining = pickN - fromIdle.length;

    // 不够的部分从活跃钱包中随机选
    const fromActive = remaining > 0
      ? sampleWithoutReplacement(activeWallets, Math.min(remaining, activeWallets.length))
      : [];

    return [...fromIdle, ...fromActive];
  }

  /** Get all wallet addresses (including non-eligible ones) for stats display */
  async getAllWalletAddresses(): Promise<Array<{ index: number; myAddress: string }>> {
    const result: Array<{ index: number; myAddress: string }> = [];
    for (let i = 0; i < this.tradingServices.length; i++) {
      const ts = this.tradingServices[i];
      try {
        await ts.initialize();
        const { my } = this.getMyAddress(ts);
        result.push({ index: this.walletIndices[i] ?? i, myAddress: my });
      } catch {
        // Skip wallets that fail to initialize
      }
    }
    return result;
  }

  /** Get all wallets as EligibleWalletInfo for SELL orders (doesn't require balance check) */
  private async getAllWalletsForSell(): Promise<EligibleWalletInfo[]> {
    const result: EligibleWalletInfo[] = [];
    for (let i = 0; i < this.tradingServices.length; i++) {
      const ts = this.tradingServices[i];
      try {
        await ts.initialize();
        const { owner, funder, my } = this.getMyAddress(ts);
        result.push({
          index: this.walletIndices[i] ?? i,
          ownerAddress: owner,
          funderAddress: funder,
          myAddress: my,
          collateralUsdc: 0, // Not needed for SELL
          tradingService: ts,
        });
      } catch {
        // Skip wallets that fail to initialize
      }
    }
    return result;
  }

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => {
      void this.refreshEligibleWallets();
    }, this.config.refreshIntervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private getMyAddress(ts: TradingService): { owner: string; funder: string | null; my: string } {
    const owner = ts.getAddress();
    const funder = (ts as any).getFunderAddress?.() ?? null;
    const my = String(funder || owner);
    return { owner, funder, my };
  }

  async refreshEligibleWallets(): Promise<EligibleWalletInfo[]> {
    const eligible: EligibleWalletInfo[] = [];

    for (let i = 0; i < this.tradingServices.length; i++) {
      const ts = this.tradingServices[i];

      try {
        await ts.initialize();
      } catch {
        continue;
      }

      let balance = 0;
      try {
        const res = await ts.getBalanceAllowance('COLLATERAL');
        balance = Number(res.balance);
      } catch {
        continue;
      }

      if (!Number.isFinite(balance) || balance < this.config.minEligibleCollateralUsdc) {
        continue;
      }

      const { owner, funder, my } = this.getMyAddress(ts);

      eligible.push({
        index: this.walletIndices[i] ?? i,
        ownerAddress: owner,
        funderAddress: funder,
        myAddress: my,
        collateralUsdc: balance,
        tradingService: ts,
      });
    }

    this.eligibleWallets = eligible;
    return eligible;
  }

  private async getPositionsCached(myAddress: string, ttlMs: number = 10_000): Promise<any[]> {
    const key = myAddress.toLowerCase();
    const now = Date.now();
    const cached = this.positionsCache.get(key);
    if (cached && now - cached.at < ttlMs) return cached.positions;

    // 带重试的持仓查询
    const positions = await withRetry(
      () => this.walletService.getWalletPositions(key),
      { maxRetries: 3, baseDelayMs: 500 }
    ).catch(() => [] as any[]);

    this.positionsCache.set(key, { at: now, positions });
    return positions;
  }

  private async isAlreadyHolding(params: { myAddress: string; conditionId?: string; outcome?: string }): Promise<boolean> {
    if (!params.conditionId || !params.outcome) return false;
    const positions = await this.getPositionsCached(params.myAddress);
    const c = String(params.conditionId).toLowerCase();
    const o = String(params.outcome).toLowerCase();
    return positions.some((p: any) =>
      String(p.conditionId || '').toLowerCase() === c &&
      String(p.outcome || '').toLowerCase() === o &&
      Number(p.size ?? 0) > 0
    );
  }

  async executeTrade(params: {
    trade: SmartMoneyTrade;
    dryRun: boolean;
    sideFilter?: 'BUY' | 'SELL';
    /** 指定要执行的钱包地址列表（用于 SELL 时只卖出绑定的钱包） */
    targetWallets?: Array<{ address: string; index: number }>;
  }): Promise<MultiAccountTradeResult> {
    const trade = params.trade;

    const tradeValue = trade.size * trade.price;
    if (tradeValue < this.config.minTradeSize) {
      return { selectedWallets: [], perWalletResults: [] };
    }

    if (params.sideFilter && trade.side !== params.sideFilter) {
      return { selectedWallets: [], perWalletResults: [] };
    }

    const tokenId = trade.tokenId;
    if (!tokenId) {
      return { selectedWallets: [], perWalletResults: [] };
    }

    // For SELL orders, we need to check ALL wallets for positions (not just eligible ones)
    // because selling doesn't require USDC balance
    let pool: EligibleWalletInfo[];
    if (trade.side === 'SELL') {
      // 如果指定了 targetWallets，只使用这些钱包
      if (params.targetWallets && params.targetWallets.length > 0) {
        const allWallets = await this.getAllWalletsForSell();
        const targetAddrs = new Set(params.targetWallets.map(w => w.address.toLowerCase()));
        pool = allWallets.filter(w => targetAddrs.has(w.myAddress.toLowerCase()));
      } else {
        pool = await this.getAllWalletsForSell();
      }
    } else {
      pool = this.eligibleWallets.slice();
    }

    if (pool.length === 0) {
      return { selectedWallets: [], perWalletResults: [] };
    }

    // 卖出时检查所有钱包（因为需要找到有持仓的钱包）
    // 买入时随机选择部分钱包
    let picked: EligibleWalletInfo[];
    if (trade.side === 'SELL') {
      // 卖出：使用指定的钱包或所有钱包，后续会根据持仓情况过滤
      picked = pool;
    } else {
      // 买入：随机选择 minWalletsPerTrade 到 maxWalletsPerTrade 个钱包
      // 优先从空闲钱包（超过 idleDaysThreshold 天未交易）中选择
      const maxPick = Math.min(this.config.maxWalletsPerTrade, pool.length);
      const minPick = Math.min(this.config.minWalletsPerTrade, maxPick);
      const pickN = getRandomIntInclusive(Math.max(1, minPick), Math.max(1, maxPick));
      picked = this.sampleWithIdlePriority(pool, pickN);
    }

    // 每个钱包独立计算跟单金额（不是总额分摊）
    let perWalletSize = trade.size * this.config.sizeScale;
    let perWalletValue = perWalletSize * trade.price;

    // 每个钱包的跟单金额受 maxSizePerTrade 限制
    if (perWalletValue > this.config.maxSizePerTrade) {
      perWalletSize = this.config.maxSizePerTrade / trade.price;
      perWalletValue = this.config.maxSizePerTrade;
    }

    const MIN_ORDER_VALUE_USDC = 1;
    if (trade.side === 'BUY' && perWalletValue < MIN_ORDER_VALUE_USDC) {
      return { selectedWallets: picked, perWalletResults: [] };
    }

    const slippagePriceRaw = trade.side === 'BUY'
      ? trade.price * (1 + this.config.maxSlippage)
      : trade.price * (1 - this.config.maxSlippage);
    const slippagePrice = clampPrice(slippagePriceRaw);

    // 并行处理钱包，限制并发数为 5，避免 API 速率限制
    const CONCURRENCY_LIMIT = 5;
    const limit = pLimit(CONCURRENCY_LIMIT);

    const processWallet = async (w: EligibleWalletInfo): Promise<{ wallet: EligibleWalletInfo; result: OrderResult }> => {
      try {
        if (trade.side === 'BUY' && !this.config.allowDuplicateBuys) {
          const holding = await this.isAlreadyHolding({ myAddress: w.myAddress, conditionId: trade.conditionId, outcome: trade.outcome });
          if (holding) {
            return { wallet: w, result: { success: false, errorMsg: 'Skipped: already holding this position' } };
          }
        }

        if (params.dryRun) {
          return { wallet: w, result: { success: true, orderId: `dry_run_${Date.now()}_${w.index}` } };
        }

        let amount: number;

        if (trade.side === 'BUY') {
          if (w.collateralUsdc < perWalletValue) {
            return { wallet: w, result: { success: false, errorMsg: 'Skipped: insufficient collateral' } };
          }
          amount = perWalletValue;
        } else {
          const positions = await this.getPositionsCached(w.myAddress);
          const c = String(trade.conditionId || '').toLowerCase();
          const o = String(trade.outcome || '').toLowerCase();
          const t = String(trade.tokenId || '').toLowerCase();

          const held = positions.find((p: any) => {
            const pc = String(p.conditionId || '').toLowerCase();
            const po = String(p.outcome || '').toLowerCase();
            const pa = String(p.asset || '').toLowerCase();
            const matchByConditionOutcome = c.length > 0 && o.length > 0 && pc === c && po === o;
            const matchByTokenId = t.length > 0 && pa === t;
            return (matchByConditionOutcome || matchByTokenId) && Number(p.size ?? 0) > 0;
          });

          const heldShares = Number(held?.size ?? 0);
          if (!Number.isFinite(heldShares) || heldShares <= 0) {
            return { wallet: w, result: { success: false, errorMsg: 'Skipped: no position to sell' } };
          }

          const desiredShares = Number(perWalletSize);
          const sellShares = Math.min(heldShares, Number.isFinite(desiredShares) ? desiredShares : 0);

          // 卖出最小限制：0.1u（基于价值而非份数）
          const MIN_SELL_VALUE_USDC = 0.1;
          const sellValue = sellShares * trade.price;
          if (!Number.isFinite(sellShares) || sellShares <= 0 || sellValue < MIN_SELL_VALUE_USDC) {
            const reason = heldShares <= 0
              ? `Skipped: no position to sell`
              : `Skipped: sell value too small ($${sellValue.toFixed(2)} < $${MIN_SELL_VALUE_USDC} minimum)`;
            return { wallet: w, result: { success: false, errorMsg: reason } };
          }

          amount = sellShares;
        }

        // 带重试的下单
        const result = await withRetry(
          () => w.tradingService.createMarketOrder({
            tokenId,
            side: trade.side,
            amount,
            price: slippagePrice,
            orderType: this.config.orderType,
          }),
          {
            maxRetries: 3,
            baseDelayMs: 1000,
            onRetry: (err, attempt) => {
              console.warn(`[MultiExecutor] #${w.index} 下单重试 ${attempt}/3: ${err?.message || String(err)}`);
            },
          }
        );

        if (result.success) {
          w.collateralUsdc = Math.max(0, w.collateralUsdc - (trade.side === 'BUY' ? amount : 0));
          this.positionsCache.delete(w.myAddress.toLowerCase());
          // 更新钱包最近交易时间
          this.lastTradeTimeMap.set(w.index, Date.now());
        }

        return { wallet: w, result };
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        const isRetryable = isRetryableError(e);
        return { wallet: w, result: { success: false, errorMsg: isRetryable ? `[重试失败] ${errMsg}` : errMsg } };
      }
    };

    // 并行执行所有钱包的处理
    const perWalletResults = await Promise.all(
      picked.map(w => limit(() => processWallet(w)))
    );

    return {
      selectedWallets: picked,
      perWalletResults,
      requestedPerWalletSize: perWalletSize,
      requestedPerWalletValue: perWalletValue,
    };
  }

  /**
   * 止损卖出：卖出所有钱包中持有指定 tokenId/conditionId 的持仓
   */
  async executeStopLossSell(params: {
    tokenId: string;
    conditionId: string;
    reason?: string;
  }): Promise<{ successCount: number; failedCount: number; results: Array<{ wallet: EligibleWalletInfo; result: OrderResult }> }> {
    const allWallets = await this.getAllWalletsForSell();
    const results: Array<{ wallet: EligibleWalletInfo; result: OrderResult }> = [];
    let successCount = 0;
    let failedCount = 0;

    for (const w of allWallets) {
      try {
        const positions = await this.getPositionsCached(w.myAddress);
        const c = String(params.conditionId || '').toLowerCase();
        const t = String(params.tokenId || '').toLowerCase();

        const held = positions.find((p: any) => {
          const pc = String(p.conditionId || '').toLowerCase();
          const pa = String(p.asset || '').toLowerCase();
          return (pc === c || pa === t) && Number(p.size ?? 0) > 0;
        });

        const heldShares = Number(held?.size ?? 0);
        // 卖出最小限制：0.1u（基于价值而非份数）
        const MIN_SELL_VALUE_USDC = 0.1;
        const curPrice = Number(held?.curPrice ?? held?.avgPrice ?? 0.5);
        const sellValue = heldShares * curPrice;
        if (!Number.isFinite(heldShares) || heldShares <= 0 || sellValue < MIN_SELL_VALUE_USDC) {
          continue; // No position or too small to sell
        }

        // Get slippage price for order
        const slippagePrice = clampPrice(curPrice * (1 - this.config.maxSlippage));

        // 带重试的止损卖出
        const result = await withRetry(
          () => w.tradingService.createMarketOrder({
            tokenId: params.tokenId,
            side: 'SELL',
            amount: heldShares,
            price: slippagePrice,
            orderType: 'FAK', // Use FAK for stop loss to maximize fill
          }),
          {
            maxRetries: 3,
            baseDelayMs: 1000,
            onRetry: (err, attempt) => {
              console.warn(`[StopLoss] #${w.index} 止损卖出重试 ${attempt}/3: ${err?.message || String(err)}`);
            },
          }
        );

        results.push({ wallet: w, result });

        if (result.success) {
          successCount++;
          this.positionsCache.delete(w.myAddress.toLowerCase());
        } else {
          failedCount++;
        }
      } catch (e: any) {
        results.push({ wallet: w, result: { success: false, errorMsg: e?.message || String(e) } });
        failedCount++;
      }
    }

    return { successCount, failedCount, results };
  }
}
