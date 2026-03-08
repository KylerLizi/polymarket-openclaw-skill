/**
 * 综合状态检查脚本
 *
 * 子命令：
 *   overview   账户余额 + 持仓价值 + 持仓数量（需要私钥）
 *   health     RPC 连通性 + API 可达性 + 代理状态
 *
 * 用法：tsx scripts/status-check.ts <subcmd>
 */

import { createReadOnlySDK, createTradingSDK, getRpcConfig, parseArgs } from './utils/sdk-factory.js';
import { success, error, run } from './utils/output-formatter.js';

const { command } = parseArgs(process.argv);

run(`status-check ${command}`, async () => {
  switch (command) {
    case 'overview': {
      const sdk = await createTradingSDK();
      const address = sdk.tradingService.getAddress();

      const [accountValue, positions] = await Promise.all([
        sdk.getAccountTotalValue(),
        sdk.wallets.getWalletPositions(address).catch(() => []),
      ]);

      const activePositions = (positions as any[]).filter(p => Number(p.size) > 0);
      const redeemable = activePositions.filter((p: any) => p.redeemable);

      success(
        'status-check overview',
        {
          address,
          usdcBalance: accountValue.usdcBalance,
          positionsValue: accountValue.positionsValue,
          totalValue: accountValue.totalValue,
          activePositions: activePositions.length,
          redeemablePositions: redeemable.length,
        },
        `账户 ${address.slice(0, 8)}... | 总价值: $${accountValue.totalValue.toFixed(2)} | 余额: $${accountValue.usdcBalance.toFixed(2)} | 持仓: ${activePositions.length} 个 (${redeemable.length} 可赎回)`
      );
      break;
    }

    case 'health': {
      const checks: Record<string, any> = {};
      const { rpcUrl, rpcUrls } = getRpcConfig();

      // 检查环境变量
      checks.env = {
        POLY_PRIVATE_KEY: process.env.POLY_PRIVATE_KEY ? 'configured' : 'missing',
        POLYGON_RPC_URLS: rpcUrls.length > 0 ? `${rpcUrls.length} endpoints` : 'missing',
        USE_PROXY: process.env.USE_PROXY || 'disabled',
        PROXY_URL: process.env.PROXY_URL || 'default (127.0.0.1:10081)',
      };

      // 测试 Gamma API
      try {
        const sdk = await createReadOnlySDK();
        const markets = await sdk.markets.getTrendingMarkets(1);
        checks.gammaApi = { status: 'ok', marketCount: markets.length };
      } catch (e: any) {
        checks.gammaApi = { status: 'error', error: e?.message };
      }

      // 测试 Data API
      try {
        const sdk = await createReadOnlySDK();
        const entries = await sdk.wallets.getLeaderboardByPeriod('day', 1);
        checks.dataApi = { status: 'ok', entries: entries.length };
      } catch (e: any) {
        checks.dataApi = { status: 'error', error: e?.message };
      }

      // 测试 RPC
      if (rpcUrl) {
        try {
          const { ethers } = await import('ethers');
          const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
          const blockNumber = await provider.getBlockNumber();
          checks.rpc = { status: 'ok', endpoint: rpcUrl, blockNumber };
        } catch (e: any) {
          checks.rpc = { status: 'error', endpoint: rpcUrl, error: e?.message };
        }
      } else {
        checks.rpc = { status: 'skipped', reason: 'POLYGON_RPC_URLS not configured' };
      }

      const allOk = Object.values(checks).every((c: any) => c.status !== 'error');

      success(
        'status-check health',
        checks,
        allOk ? '所有服务正常' : '部分服务异常，请检查配置'
      );
      break;
    }

    default:
      error(
        'status-check',
        command ? `未知子命令: ${command}` : '缺少子命令',
        '可用子命令: overview, health'
      );
  }
});
