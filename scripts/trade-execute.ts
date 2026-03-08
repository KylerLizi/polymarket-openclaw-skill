/**
 * 手动交易脚本（需要私钥，高危操作）
 *
 * 子命令：
 *   buy <tokenId> <size> <price> [--type=GTC]    限价买入
 *   sell <tokenId> <size> <price> [--type=GTC]    限价卖出
 *   market-buy <tokenId> <amount>                 市价买入 (FAK)
 *   market-sell <tokenId> <amount>                市价卖出 (FAK)
 *   cancel <orderId>                              取消订单
 *   cancel-all                                    取消所有挂单
 *   open-orders [marketId]                        查看挂单列表
 *   trades [marketId]                             查看历史成交
 *
 * 安全机制：
 *   - 默认 --dry-run，只输出操作预览不实际下单
 *   - 必须显式传 --confirm 才执行
 *   - 单笔 > $50 黄色警告，> $200 红色警告
 *
 * 用法：tsx scripts/trade-execute.ts <subcmd> [args...] [--confirm] [--dry-run]
 */

import { createTradingSDK, parseArgs } from './utils/sdk-factory.js';
import { success, error, run } from './utils/output-formatter.js';

const { command, positional, flags } = parseArgs(process.argv);

const isConfirm = flags.confirm === true;
const isDryRun = !isConfirm; // 默认 dry-run

function amountWarning(amount: number): string | null {
  if (amount > 200) return `⚠️ 高额警告: 单笔交易 $${amount.toFixed(2)} 超过 $200，请确认风险`;
  if (amount > 50) return `⚠️ 注意: 单笔交易 $${amount.toFixed(2)} 超过 $50`;
  return null;
}

run(`trade-execute ${command}`, async () => {
  // 查询类命令不需要 --confirm
  if (command === 'open-orders' || command === 'trades') {
    const sdk = await createTradingSDK();
    const marketId = positional[0] || undefined;

    if (command === 'open-orders') {
      const orders = await sdk.tradingService.getOpenOrders(marketId);
      success(
        'trade-execute open-orders',
        orders,
        `当前 ${orders.length} 个挂单${marketId ? ` (市场: ${marketId})` : ''}`
      );
    } else {
      const trades = await sdk.tradingService.getTrades(marketId);
      success(
        'trade-execute trades',
        trades,
        `共 ${trades.length} 笔历史成交${marketId ? ` (市场: ${marketId})` : ''}`
      );
    }
    return;
  }

  switch (command) {
    case 'buy':
    case 'sell': {
      const tokenId = positional[0];
      const size = positional[1] ? parseFloat(positional[1]) : NaN;
      const price = positional[2] ? parseFloat(positional[2]) : NaN;
      const orderType = String(flags.type || 'GTC').toUpperCase();

      if (!tokenId || !Number.isFinite(size) || !Number.isFinite(price)) {
        error(`trade-execute ${command}`, '参数不完整', `用法：tsx scripts/trade-execute.ts ${command} <tokenId> <size> <price> [--type=GTC] [--confirm]`);
        return;
      }

      if (price <= 0 || price >= 1) {
        error(`trade-execute ${command}`, '价格必须在 0-1 之间', 'Polymarket 价格范围: (0, 1)');
        return;
      }

      const amount = size * price;
      const side = command === 'buy' ? 'BUY' : 'SELL';

      const preview = {
        action: `${side} ${orderType}`,
        tokenId,
        size,
        price,
        estimatedCost: `$${amount.toFixed(2)}`,
        isDryRun,
        warning: amountWarning(amount),
      };

      if (isDryRun) {
        success(
          `trade-execute ${command}`,
          preview,
          `[DRY-RUN] ${side} ${size} shares @ $${price} (预计 $${amount.toFixed(2)})。使用 --confirm 执行实盘交易`
        );
        return;
      }

      const sdk = await createTradingSDK();
      const result = await sdk.tradingService.createLimitOrder({
        tokenId,
        side: side as 'BUY' | 'SELL',
        price,
        size,
        orderType: orderType as 'GTC' | 'GTD',
      });

      success(
        `trade-execute ${command}`,
        { ...preview, result },
        result.success
          ? `${side} 成功! orderId: ${result.orderId || result.orderIds?.[0] || 'N/A'}`
          : `${side} 失败: ${result.errorMsg || '未知错误'}`
      );
      break;
    }

    case 'market-buy':
    case 'market-sell': {
      const tokenId = positional[0];
      const amount = positional[1] ? parseFloat(positional[1]) : NaN;

      if (!tokenId || !Number.isFinite(amount)) {
        error(`trade-execute ${command}`, '参数不完整', `用法：tsx scripts/trade-execute.ts ${command} <tokenId> <amount> [--confirm]`);
        return;
      }

      const side = command === 'market-buy' ? 'BUY' : 'SELL';

      const preview = {
        action: `${side} FAK (市价)`,
        tokenId,
        amount: `$${amount.toFixed(2)}`,
        isDryRun,
        warning: amountWarning(amount),
      };

      if (isDryRun) {
        success(
          `trade-execute ${command}`,
          preview,
          `[DRY-RUN] 市价${side === 'BUY' ? '买入' : '卖出'} $${amount.toFixed(2)}。使用 --confirm 执行实盘交易`
        );
        return;
      }

      const sdk = await createTradingSDK();
      const result = await sdk.tradingService.createMarketOrder({
        tokenId,
        side: side as 'BUY' | 'SELL',
        amount,
        orderType: 'FAK',
      });

      success(
        `trade-execute ${command}`,
        { ...preview, result },
        result.success
          ? `市价${side === 'BUY' ? '买入' : '卖出'}成功!`
          : `市价${side === 'BUY' ? '买入' : '卖出'}失败: ${result.errorMsg || '未知错误'}`
      );
      break;
    }

    case 'cancel': {
      const orderId = positional[0];
      if (!orderId) {
        error('trade-execute cancel', '缺少 orderId', '用法：tsx scripts/trade-execute.ts cancel <orderId> [--confirm]');
        return;
      }

      if (isDryRun) {
        success('trade-execute cancel', { orderId, isDryRun: true }, `[DRY-RUN] 将取消订单 ${orderId}。使用 --confirm 执行`);
        return;
      }

      const sdk = await createTradingSDK();
      const result = await sdk.tradingService.cancelOrder(orderId);
      success(
        'trade-execute cancel',
        result,
        result.success ? `已取消订单 ${orderId}` : `取消失败: ${result.errorMsg || '未知错误'}`
      );
      break;
    }

    case 'cancel-all': {
      if (isDryRun) {
        const sdk = await createTradingSDK();
        const orders = await sdk.tradingService.getOpenOrders();
        success('trade-execute cancel-all', { orderCount: orders.length, isDryRun: true }, `[DRY-RUN] 将取消 ${orders.length} 个挂单。使用 --confirm 执行`);
        return;
      }

      const sdk = await createTradingSDK();
      const result = await sdk.tradingService.cancelAllOrders();
      success(
        'trade-execute cancel-all',
        result,
        result.success ? '已取消所有挂单' : `取消失败: ${result.errorMsg || '未知错误'}`
      );
      break;
    }

    default:
      error(
        'trade-execute',
        command ? `未知子命令: ${command}` : '缺少子命令',
        '可用子命令: buy, sell, market-buy, market-sell, cancel, cancel-all, open-orders, trades'
      );
  }
});
