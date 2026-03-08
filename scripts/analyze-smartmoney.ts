/**
 * 聪明钱分析脚本（无需私钥）
 *
 * 子命令：
 *   leaderboard [--period=week] [--sort=pnl] [--top=20]  排行榜
 *   report <address>                                      钱包分析报告
 *   compare <addr1> <addr2>                               对比两个钱包
 *   smart-list [--limit=20]                               聪明钱列表
 *   info <address>                                        聪明钱信息
 *
 * 用法：tsx scripts/analyze-smartmoney.ts <subcmd> [args...] [--flags]
 */

import { createReadOnlySDK, parseArgs } from './utils/sdk-factory.js';
import { success, error, run } from './utils/output-formatter.js';

const { command, positional, flags } = parseArgs(process.argv);

run(`analyze-smartmoney ${command}`, async () => {
  const sdk = await createReadOnlySDK();

  switch (command) {
    case 'leaderboard': {
      const period = String(flags.period || 'week') as 'day' | 'week' | 'month' | 'all';
      const sortBy = String(flags.sort || 'pnl') as 'pnl' | 'volume';
      const limit = flags.top ? parseInt(String(flags.top), 10) : 20;

      const entries = await sdk.smartMoney.getLeaderboard({
        period,
        sortBy,
        limit,
      });

      success(
        'analyze-smartmoney leaderboard',
        entries,
        `排行榜（${period}, 按${sortBy}排序） 共 ${entries.length} 名交易者`
      );
      break;
    }

    case 'report': {
      const address = positional[0];
      if (!address) {
        error('analyze-smartmoney report', '缺少钱包地址', '用法：tsx scripts/analyze-smartmoney.ts report <address>');
        return;
      }

      const report = await sdk.smartMoney.getWalletReport(address);
      const overview = report.overview;
      success(
        `analyze-smartmoney report ${address}`,
        report,
        `钱包 ${address.slice(0, 8)}... | 总PnL: $${overview?.totalPnL?.toFixed(2) || 'N/A'} | 持仓: ${overview?.positionCount || 0} | 交易: ${overview?.tradeCount || 0}`
      );
      break;
    }

    case 'compare': {
      const addr1 = positional[0];
      const addr2 = positional[1];
      if (!addr1 || !addr2) {
        error('analyze-smartmoney compare', '需要两个钱包地址', '用法：tsx scripts/analyze-smartmoney.ts compare <addr1> <addr2>');
        return;
      }

      const period = String(flags.period || 'week') as 'day' | 'week' | 'month' | 'all';
      const comparison = await sdk.smartMoney.compareWallets([addr1, addr2], { period });
      success(
        `analyze-smartmoney compare`,
        comparison,
        `对比钱包 ${addr1.slice(0, 8)}... vs ${addr2.slice(0, 8)}...`
      );
      break;
    }

    case 'smart-list': {
      const limit = flags.limit ? parseInt(String(flags.limit), 10) : 20;
      const list = await sdk.smartMoney.getSmartMoneyList(limit);
      success(
        'analyze-smartmoney smart-list',
        list,
        `获取到 ${list.length} 个聪明钱钱包`
      );
      break;
    }

    case 'info': {
      const address = positional[0];
      if (!address) {
        error('analyze-smartmoney info', '缺少钱包地址', '用法：tsx scripts/analyze-smartmoney.ts info <address>');
        return;
      }

      const info = await sdk.smartMoney.getSmartMoneyInfo(address);
      if (info) {
        success(
          `analyze-smartmoney info ${address}`,
          info,
          `钱包 ${address.slice(0, 8)}... 是聪明钱`
        );
      } else {
        success(
          `analyze-smartmoney info ${address}`,
          null,
          `钱包 ${address.slice(0, 8)}... 不在聪明钱列表中`
        );
      }
      break;
    }

    default:
      error(
        'analyze-smartmoney',
        command ? `未知子命令: ${command}` : '缺少子命令',
        '可用子命令: leaderboard, report, compare, smart-list, info'
      );
  }
});
