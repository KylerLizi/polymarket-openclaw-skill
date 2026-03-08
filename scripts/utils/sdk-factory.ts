/**
 * SDK 实例工厂 — 统一初始化 + 代理配置
 */
import { createRequire } from 'module';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { PolymarketSDK } from '../../src/sdk/index.js';
import { RateLimiter } from '../../src/sdk/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/sdk/core/unified-cache.js';
import { TradingService } from '../../src/sdk/services/trading-service.js';
import { OnchainService } from '../../src/sdk/services/onchain-service.js';
import { RelayerRedeemService } from '../../src/sdk/services/relayer-redeem-service.js';

// ── 代理配置 ────────────────────────────────────────────────

function setupProxy(): void {
  const useProxy = process.env.USE_PROXY === '1' || process.env.USE_PROXY === 'true';
  if (useProxy) {
    const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:10081';
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;
    const require = createRequire(import.meta.url);
    const { bootstrap } = require('global-agent') as { bootstrap: () => void };
    bootstrap();
  } else {
    delete process.env.PROXY_URL;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  }
}

// 模块加载时自动配置代理
setupProxy();

// ── 抑制 Safe 日志噪音 ──────────────────────────────────────

const originalLog = console.log.bind(console);
let suppressNext = false;

console.log = (...args: any[]) => {
  const first = args[0];
  if (typeof first === 'string') {
    if (first.includes('Created Safe Transaction Request')) { suppressNext = true; return; }
    if (first.includes('Client side safe request creation took')) return;
    if (first.includes('Waiting for transaction') && first.includes('matching states')) return;
  }
  if (suppressNext && args.length === 1 && args[0]?.type?.toUpperCase?.() === 'SAFE') {
    suppressNext = false;
    return;
  }
  return originalLog(...args);
};

// ── SDK 工厂方法 ────────────────────────────────────────────

/**
 * 创建只读 SDK（无需私钥，仅查询）
 */
export async function createReadOnlySDK(): Promise<PolymarketSDK> {
  const sdk = new PolymarketSDK();
  return sdk;
}

/**
 * 创建交易 SDK（需要 POLY_PRIVATE_KEY）
 */
export async function createTradingSDK(): Promise<PolymarketSDK> {
  const privateKey = process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('POLY_PRIVATE_KEY 环境变量未设置');
  }
  const sdk = await PolymarketSDK.create({
    privateKey,
  });
  return sdk;
}

/**
 * 获取 RPC URL 配置
 */
export function getRpcConfig(): { rpcUrl: string; rpcUrls: string[] } {
  const urls = process.env.POLYGON_RPC_URLS?.split(',').map(u => u.trim()).filter(Boolean) || [];
  return {
    rpcUrl: urls[0] || 'https://polygon-rpc.com',
    rpcUrls: urls,
  };
}

/**
 * 创建 TradingService 实例（用于交易执行）
 */
export async function createTradingService(): Promise<TradingService> {
  const privateKey = process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('POLY_PRIVATE_KEY 环境变量未设置');
  }
  const { rpcUrl, rpcUrls } = getRpcConfig();
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const tradingService = new TradingService(rateLimiter, cache, {
    privateKey,
    chainId: 137,
    rpcUrl,
    rpcUrls,
  });
  await tradingService.initialize();
  return tradingService;
}

/**
 * 创建 OnchainService 实例（用于链上操作）
 */
export function createOnchainService(): OnchainService {
  const privateKey = process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('POLY_PRIVATE_KEY 环境变量未设置');
  }
  const { rpcUrl, rpcUrls } = getRpcConfig();
  return new OnchainService({
    privateKey,
    rpcUrl,
    rpcUrls,
    chainId: 137,
  });
}

// ── 参数解析 ────────────────────────────────────────────────

/**
 * 简易命令行参数解析
 * 支持：--key=value, --flag, 位置参数
 */
export function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2); // 跳过 node 和脚本路径
  const command = args[0] || '';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}
