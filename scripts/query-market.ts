/**
 * 市场查询脚本（无需私钥）
 *
 * 子命令：
 *   search <keyword>              搜索活跃市场
 *   detail <slug|conditionId>     市场详情（价格/成交量/状态）
 *   orderbook <conditionId>       加工后的订单簿（YES/NO bid/ask/spread）
 *   arb <conditionId> [threshold] 套利机会检测
 *   trending [limit]              热门市场列表
 *   klines <conditionId> <interval> K线数据（YES+NO）
 *   spread <conditionId>          实时 spread 分析
 *
 * 用法：tsx scripts/query-market.ts <subcmd> [args...] [--flags]
 */

import { createReadOnlySDK, parseArgs } from './utils/sdk-factory.js';
import { success, error, run } from './utils/output-formatter.js';
import type { KLineInterval } from '../src/sdk/core/types.js';

const { command, positional, flags } = parseArgs(process.argv);

run(`query-market ${command}`, async () => {
  const sdk = await createReadOnlySDK();

  switch (command) {
    case 'search': {
      const keyword = positional[0];
      if (!keyword) {
        error('query-market search', '缺少搜索关键词', '用法：tsx scripts/query-market.ts search <keyword>');
        return;
      }
      // GammaAPI 通过 slug 模糊匹配搜索
      const results = await sdk.gammaApi.getMarkets({ slug: keyword, active: true, limit: 20 });
      success(
        `query-market search ${keyword}`,
        results,
        `找到 ${results.length} 个与 '${keyword}' 相关的市场`
      );
      break;
    }

    case 'detail': {
      const identifier = positional[0];
      if (!identifier) {
        error('query-market detail', '缺少市场标识', '用法：tsx scripts/query-market.ts detail <slug|conditionId>');
        return;
      }
      const market = await sdk.markets.getMarket(identifier);
      success(
        `query-market detail ${identifier}`,
        market,
        `市场「${market.question}」- ${market.active ? '活跃' : '已关闭'}, 成交量 $${market.volume?.toLocaleString?.() || 'N/A'}`
      );
      break;
    }

    case 'orderbook': {
      const conditionId = positional[0];
      if (!conditionId) {
        error('query-market orderbook', '缺少 conditionId', '用法：tsx scripts/query-market.ts orderbook <conditionId>');
        return;
      }
      const orderbook = await sdk.markets.getProcessedOrderbook(conditionId);
      success(
        `query-market orderbook ${conditionId}`,
        orderbook,
        `YES: bid=${orderbook.yes.bid.toFixed(4)} ask=${orderbook.yes.ask.toFixed(4)} | NO: bid=${orderbook.no.bid.toFixed(4)} ask=${orderbook.no.ask.toFixed(4)} | Spread: ${(orderbook.summary.yesSpread * 100).toFixed(2)}%`
      );
      break;
    }

    case 'arb': {
      const conditionId = positional[0];
      if (!conditionId) {
        error('query-market arb', '缺少 conditionId', '用法：tsx scripts/query-market.ts arb <conditionId> [threshold]');
        return;
      }
      const threshold = positional[1] ? parseFloat(positional[1]) : 0.005;
      const arb = await sdk.detectArbitrage(conditionId, threshold);
      if (arb) {
        success(
          `query-market arb ${conditionId}`,
          arb,
          `发现 ${arb.type} 套利机会！预期利润: ${(arb.profit * 100).toFixed(2)}%`
        );
      } else {
        success(
          `query-market arb ${conditionId}`,
          null,
          `未发现套利机会（阈值: ${(threshold * 100).toFixed(2)}%）`
        );
      }
      break;
    }

    case 'trending': {
      const limit = positional[0] ? parseInt(positional[0], 10) : 10;
      const markets = await sdk.markets.getTrendingMarkets(limit);
      const data = markets.map(m => ({
        slug: m.slug,
        question: m.question,
        volume: m.volume,
        liquidity: m.liquidity,
        outcomes: m.outcomes,
        outcomePrices: m.outcomePrices,
      }));
      success(
        `query-market trending ${limit}`,
        data,
        `获取到 ${data.length} 个热门市场`
      );
      break;
    }

    case 'klines': {
      const conditionId = positional[0];
      const interval = (positional[1] || '1h') as KLineInterval;
      if (!conditionId) {
        error('query-market klines', '缺少 conditionId', '用法：tsx scripts/query-market.ts klines <conditionId> <interval>');
        return;
      }
      const klines = await sdk.markets.getDualKLines(conditionId, interval);
      const yesCount = klines.yes?.length || 0;
      const noCount = klines.no?.length || 0;
      success(
        `query-market klines ${conditionId} ${interval}`,
        klines,
        `YES ${yesCount} 根K线, NO ${noCount} 根K线, 间隔 ${interval}`
      );
      break;
    }

    case 'spread': {
      const conditionId = positional[0];
      if (!conditionId) {
        error('query-market spread', '缺少 conditionId', '用法：tsx scripts/query-market.ts spread <conditionId>');
        return;
      }
      const spreadData = await sdk.markets.getRealtimeSpread(conditionId);
      success(
        `query-market spread ${conditionId}`,
        spreadData,
        `实时 Spread 分析完成`
      );
      break;
    }

    default:
      error(
        'query-market',
        command ? `未知子命令: ${command}` : '缺少子命令',
        '可用子命令: search, detail, orderbook, arb, trending, klines, spread'
      );
  }
});
