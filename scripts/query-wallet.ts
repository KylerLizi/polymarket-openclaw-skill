/**
 * 钱包查询脚本
 *
 * 子命令：
 *   positions <address>                查询钱包持仓
 *   profile <address>                  钱包画像（PnL/交易统计）
 *   balance                            查询自己的余额（需要私钥）
 *   activity <address> [--limit=20]    钱包最近活动
 *   leaderboard [--period=week] [--top=50]  排行榜
 *
 * 用法：tsx scripts/query-wallet.ts <subcmd> [args...] [--flags]
 */

import { createReadOnlySDK, createTradingSDK, parseArgs } from './utils/sdk-factory.js';
import { success, error, run } from './utils/output-formatter.js';
import type { TimePeriod } from '../src/sdk/services/wallet-service.js';

const { command, positional, flags } = parseArgs(process.argv);

run(`query-wallet ${command}`, async () => {
  switch (command) {
    case 'positions': {
      const address = positional[0];
      if (!address) {
        error('query-wallet positions', '缺少钱包地址', '用法：tsx scripts/query-wallet.ts positions <address>');
        return;
      }
      const sdk = await createReadOnlySDK();
      const positions = await sdk.wallets.getWalletPositions(address);
      const activePositions = positions.filter((p: any) => Number(p.size) > 0);
      success(
        `query-wallet positions ${address}`,
        positions,
        `钱包 ${address.slice(0, 8)}... 共 ${positions.length} 个持仓（${activePositions.length} 个活跃）`
      );
      break;
    }

    case 'profile': {
      const address = positional[0];
      if (!address) {
        error('query-wallet profile', '缺少钱包地址', '用法：tsx scripts/query-wallet.ts profile <address>');
        return;
      }
      const sdk = await createReadOnlySDK();
      const profile = await sdk.wallets.getWalletProfile(address);
      success(
        `query-wallet profile ${address}`,
        profile,
        `钱包 ${address.slice(0, 8)}... | 总PnL: $${profile.totalPnL?.toFixed(2) || 'N/A'} | 持仓数: ${profile.positionCount || 0} | 交易数: ${profile.tradeCount || 0}`
      );
      break;
    }

    case 'balance': {
      const sdk = await createTradingSDK();
      const value = await sdk.getAccountTotalValue();
      const address = sdk.tradingService.getAddress();
      success(
        'query-wallet balance',
        {
          address,
          positionsValue: value.positionsValue,
          usdcBalance: value.usdcBalance,
          totalValue: value.totalValue,
        },
        `账户 ${address.slice(0, 8)}... | 持仓: $${value.positionsValue.toFixed(2)} | 余额: $${value.usdcBalance.toFixed(2)} | 总计: $${value.totalValue.toFixed(2)}`
      );
      break;
    }

    case 'activity': {
      const address = positional[0];
      if (!address) {
        error('query-wallet activity', '缺少钱包地址', '用法：tsx scripts/query-wallet.ts activity <address> [--limit=20]');
        return;
      }
      const limit = flags.limit ? parseInt(String(flags.limit), 10) : 20;
      const sdk = await createReadOnlySDK();
      const activity = await sdk.wallets.getWalletActivity(address, { limit });
      success(
        `query-wallet activity ${address}`,
        activity,
        `钱包 ${address.slice(0, 8)}... 最近 ${activity.activities?.length || 0} 条活动 | 买入量: $${activity.summary?.buyVolume?.toFixed(2) || '0'} | 卖出量: $${activity.summary?.sellVolume?.toFixed(2) || '0'}`
      );
      break;
    }

    case 'leaderboard': {
      const period = (String(flags.period || 'week')) as TimePeriod;
      const top = flags.top ? parseInt(String(flags.top), 10) : 50;
      const sdk = await createReadOnlySDK();
      const entries = await sdk.wallets.getLeaderboardByPeriod(period, top);
      success(
        `query-wallet leaderboard`,
        entries,
        `排行榜（${period}） 共 ${entries.length} 名交易者`
      );
      break;
    }

    default:
      error(
        'query-wallet',
        command ? `未知子命令: ${command}` : '缺少子命令',
        '可用子命令: positions, profile, balance, activity, leaderboard'
      );
  }
});
