/**
 * 账户管理脚本（需要私钥）
 *
 * 子命令：
 *   redeem [--dry-run] [--include-ended]  赎回所有已解决头寸
 *   clear [--dry-run] [--slippage=0.05]   清仓（已解决赎回 + 未解决卖出）
 *   positions                             列出当前所有头寸及状态
 *
 * 用法：tsx scripts/manage-account.ts <subcmd> [--flags]
 */

import {
  createUnifiedCache,
  DataApiClient,
  RateLimiter,
  SubgraphClient,
  WalletService,
  TradingService,
  OnchainService,
} from '../src/sdk/index.js';
import { createTradingSDK, getRpcConfig, parseArgs } from './utils/sdk-factory.js';
import { success, error, run } from './utils/output-formatter.js';

const { command, positional, flags } = parseArgs(process.argv);

// 默认 dry-run，除非显式 --confirm
const isConfirm = flags.confirm === true;
const isDryRun = flags['dry-run'] === true || !isConfirm;
const includeEnded = flags['include-ended'] === true;
const maxSlippage = flags.slippage ? parseFloat(String(flags.slippage)) : 0.05;

type WalletPosition = {
  asset: string;
  conditionId: string;
  outcome: string;
  outcomeIndex?: number;
  size: number;
  curPrice?: number;
  avgPrice: number;
  title?: string;
  slug?: string;
  oppositeAsset?: string;
  redeemable?: boolean;
  endDate?: string;
};

function isEnded(p: WalletPosition): boolean {
  const endMs = p.endDate ? Date.parse(p.endDate) : NaN;
  return Number.isFinite(endMs) && endMs > 0 && endMs <= Date.now();
}

function clampPrice(price: number): number {
  return Number.parseFloat(Math.max(0.001, Math.min(0.999, price)).toFixed(6));
}

run(`manage-account ${command}`, async () => {
  switch (command) {
    case 'positions': {
      const sdk = await createTradingSDK();
      const address = sdk.tradingService.getAddress();
      const positions = await sdk.wallets.getWalletPositions(address);
      const active = positions.filter((p: any) => Number(p.size) > 0);
      const redeemable = active.filter((p: any) => p.redeemable);
      const ended = active.filter((p: any) => isEnded(p) && !p.redeemable);

      success(
        'manage-account positions',
        { address, positions: active, stats: { total: active.length, redeemable: redeemable.length, ended: ended.length, open: active.length - redeemable.length - ended.length } },
        `地址 ${address.slice(0, 8)}... | 活跃持仓 ${active.length} | 可赎回 ${redeemable.length} | 已结束 ${ended.length}`
      );
      break;
    }

    case 'redeem': {
      const sdk = await createTradingSDK();
      const address = sdk.tradingService.getAddress();
      const positions: WalletPosition[] = await sdk.wallets.getWalletPositions(address).catch(() => []);

      const candidates = positions.filter(p => {
        if (!p?.conditionId || Number(p.size) <= 0) return false;
        if (p.redeemable) return true;
        return includeEnded && isEnded(p);
      });

      // 按 conditionId 去重
      const byCondition = new Map<string, WalletPosition>();
      for (const p of candidates) {
        if (!byCondition.has(p.conditionId)) byCondition.set(p.conditionId, p);
      }

      if (byCondition.size === 0) {
        success('manage-account redeem', { address, candidates: 0 }, '没有可赎回的头寸');
        return;
      }

      const results: any[] = [];
      const { rpcUrl, rpcUrls } = getRpcConfig();
      const privateKey = process.env.POLY_PRIVATE_KEY!;
      const onchainService = (rpcUrl || rpcUrls.length > 0)
        ? new OnchainService({ privateKey, rpcUrl, rpcUrls, chainId: 137 })
        : null;

      for (const [conditionId, p] of byCondition) {
        const title = String(p.title || p.slug || conditionId).slice(0, 80);

        if (isDryRun) {
          results.push({ conditionId, title, action: 'DRY-RUN redeem', status: 'preview' });
          continue;
        }

        if (!onchainService) {
          results.push({ conditionId, title, action: 'skip', reason: '没有可用的 RPC 端点' });
          continue;
        }

        try {
          const resolution = await onchainService.getMarketResolution(conditionId);
          if (!resolution.isResolved) {
            results.push({ conditionId, title, action: 'skip', reason: '市场未解决' });
            continue;
          }

          const tokenId = p.asset;
          const oppositeTokenId = p.oppositeAsset || '';
          const idx = Number(p.outcomeIndex);
          const tokenIds = idx === 0
            ? { yesTokenId: tokenId, noTokenId: oppositeTokenId }
            : { yesTokenId: oppositeTokenId, noTokenId: tokenId };

          const winning = (resolution as any).winningOutcome as string | undefined;
          const res = await onchainService.redeemByTokenIds(
            conditionId,
            tokenIds,
            winning === 'YES' ? 'YES' : winning === 'NO' ? 'NO' : undefined
          );

          results.push({
            conditionId, title,
            action: 'redeem',
            status: res.success ? 'success' : 'failed',
            txHash: res.txHash,
          });
        } catch (e: any) {
          results.push({ conditionId, title, action: 'redeem', status: 'error', error: e?.message });
        }
      }

      const succeeded = results.filter(r => r.status === 'success').length;
      const previewed = results.filter(r => r.status === 'preview').length;

      success(
        'manage-account redeem',
        { address, results },
        isDryRun
          ? `[DRY-RUN] ${previewed} 个头寸可赎回。使用 --confirm 执行实际赎回`
          : `赎回完成: ${succeeded}/${byCondition.size} 成功`
      );
      break;
    }

    case 'clear': {
      const sdk = await createTradingSDK();
      const address = sdk.tradingService.getAddress();
      const positions: WalletPosition[] = await sdk.wallets.getWalletPositions(address).catch(() => []);

      const active = positions.filter(p => p?.conditionId && Number(p.size) > 0);
      if (active.length === 0) {
        success('manage-account clear', { address, positions: 0 }, '没有需要清仓的持仓');
        return;
      }

      const results: any[] = [];

      for (const p of active) {
        const title = String(p.title || p.slug || p.conditionId).slice(0, 80);
        const size = Number(p.size);
        const shouldRedeem = Boolean(p.redeemable) || (includeEnded && isEnded(p));

        if (shouldRedeem) {
          results.push({
            conditionId: p.conditionId, title,
            action: isDryRun ? 'DRY-RUN redeem' : 'redeem',
            status: 'preview',
          });
          continue;
        }

        const curPrice = Number.isFinite(Number(p.curPrice)) && Number(p.curPrice) > 0
          ? Number(p.curPrice)
          : (Number.isFinite(Number(p.avgPrice)) && Number(p.avgPrice) > 0 ? Number(p.avgPrice) : 0.5);
        const dollarValue = size * curPrice;

        if (dollarValue < 0.1) {
          results.push({ conditionId: p.conditionId, title, action: 'skip', reason: `价值 $${dollarValue.toFixed(2)} 过小` });
          continue;
        }

        const price = clampPrice(curPrice * (1 - maxSlippage));

        if (isDryRun) {
          results.push({
            conditionId: p.conditionId, title,
            action: 'DRY-RUN sell',
            size: size.toFixed(2),
            price,
            estimatedValue: `$${dollarValue.toFixed(2)}`,
            status: 'preview',
          });
          continue;
        }

        try {
          const res = await sdk.tradingService.createMarketOrder({
            tokenId: p.asset,
            side: 'SELL',
            amount: size,
            price,
            orderType: 'FAK',
          });

          results.push({
            conditionId: p.conditionId, title,
            action: 'sell',
            status: res.success ? 'success' : 'failed',
            error: res.errorMsg,
          });
        } catch (e: any) {
          results.push({
            conditionId: p.conditionId, title,
            action: 'sell',
            status: 'error',
            error: e?.message,
          });
        }
      }

      const previewed = results.filter(r => r.status === 'preview').length;
      const succeeded = results.filter(r => r.status === 'success').length;

      success(
        'manage-account clear',
        { address, results, slippage: maxSlippage },
        isDryRun
          ? `[DRY-RUN] ${previewed} 个持仓将被清仓。使用 --confirm 执行`
          : `清仓完成: ${succeeded}/${active.length} 成功`
      );
      break;
    }

    default:
      error(
        'manage-account',
        command ? `未知子命令: ${command}` : '缺少子命令',
        '可用子命令: positions, redeem, clear'
      );
  }
});
