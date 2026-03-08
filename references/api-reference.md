# Polymarket SDK API Quick Reference

## SDK Initialization

```typescript
import { PolymarketSDK } from '../src/sdk/index.js';

// Read-only (no private key)
const sdk = new PolymarketSDK();

// With trading capability
const sdk = await PolymarketSDK.create({ privateKey: '0x...' });
```

## MarketService (`sdk.markets`)

| Method | Returns | Description |
|--------|---------|-------------|
| `getMarket(slug\|conditionId)` | `UnifiedMarket` | Market details (price, volume, status) |
| `getProcessedOrderbook(conditionId)` | `ProcessedOrderbook` | Analyzed orderbook with YES/NO bid/ask/spread |
| `getTrendingMarkets(limit?)` | `GammaMarket[]` | Hot markets list |
| `getKLines(conditionId, interval)` | `DualKLineData` | K-line data for YES+NO tokens |
| `getRealtimeSpread(conditionId)` | `RealtimeSpreadAnalysis` | Real-time spread analysis |
| `getMidpoint(tokenId)` | `number` | Current midpoint price |
| `getSpread(tokenId)` | `number` | Current spread |
| `detectArbitrage(conditionId, threshold?)` | `ArbitrageOpportunity\|null` | Arbitrage detection |

## GammaApiClient (`sdk.gammaApi`)

| Method | Returns | Description |
|--------|---------|-------------|
| `searchMarkets({ query })` | `GammaMarket[]` | Search markets by keyword |

## WalletService (`sdk.wallets`)

| Method | Returns | Description |
|--------|---------|-------------|
| `getWalletPositions(address)` | `Position[]` | Wallet positions |
| `getWalletProfile(address)` | `WalletProfile` | Wallet PnL, trade stats |
| `getWalletActivity(address, opts?)` | `WalletActivitySummary` | Recent activity |
| `getLeaderboardByPeriod(period, limit?, sortBy?)` | `PeriodLeaderboardEntry[]` | Time-based leaderboard |

## TradingService (`sdk.tradingService`)

| Method | Returns | Description |
|--------|---------|-------------|
| `initialize()` | `void` | Required before trading |
| `createLimitOrder(params)` | `OrderResult` | Place limit order (GTC/GTD) |
| `createMarketOrder(params)` | `OrderResult` | Place market order (FOK/FAK) |
| `cancelOrder(orderId)` | `OrderResult` | Cancel single order |
| `cancelAllOrders()` | `OrderResult` | Cancel all open orders |
| `getOpenOrders(marketId?)` | `Order[]` | List open orders |
| `getTrades(marketId?)` | `TradeInfo[]` | Trade history |
| `getBalanceAllowance('COLLATERAL')` | `{ balance, allowance }` | USDC balance |
| `getAddress()` | `string` | Wallet address |

### Order Parameters

```typescript
// Limit order
{ tokenId: string, side: 'BUY'|'SELL', price: number, size: number, orderType?: 'GTC'|'GTD' }

// Market order
{ tokenId: string, side: 'BUY'|'SELL', amount: number, price?: number, orderType?: 'FOK'|'FAK' }
```

## SmartMoneyService (`sdk.smartMoney`)

| Method | Returns | Description |
|--------|---------|-------------|
| `getLeaderboard(opts?)` | `SmartMoneyLeaderboardEntry[]` | Smart money leaderboard |
| `getWalletReport(address)` | `WalletReport` | Comprehensive wallet analysis |
| `compareWallets(addresses, opts?)` | `WalletComparison` | Compare wallets |
| `getSmartMoneyList(limit?)` | `SmartMoneyWallet[]` | Smart money list |
| `getSmartMoneyInfo(address)` | `SmartMoneyWallet\|null` | Check if wallet is smart money |

## OnchainService

| Method | Returns | Description |
|--------|---------|-------------|
| `getMarketResolution(conditionId)` | `MarketResolution` | Check if market resolved |
| `redeemByTokenIds(conditionId, tokenIds, winner?)` | `RedeemResult` | Redeem resolved positions |

## Key Types

```typescript
type Side = 'BUY' | 'SELL';
type OrderType = 'GTC' | 'FOK' | 'GTD' | 'FAK';
type TimePeriod = 'day' | 'week' | 'month' | 'all';
type KLineInterval = '1s'|'5s'|'15s'|'30s'|'1m'|'5m'|'15m'|'30m'|'1h'|'4h'|'12h'|'1d';

interface UnifiedMarket {
  conditionId: string;
  slug: string;
  question: string;
  tokens: MarketToken[];
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
}

interface ProcessedOrderbook {
  yes: { bids, asks };
  no: { bids, asks };
  summary: { yes: { bestBid, bestAsk }, no: { bestBid, bestAsk }, spread, effectivePrices, longArbProfit, shortArbProfit };
}

interface WalletProfile {
  address: string;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  positionCount: number;
  tradeCount: number;
}

interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
}
```

## Polymarket Concepts

- **Orderbook Mirror**: Buy YES @ P = Sell NO @ (1-P). Use `getEffectivePrices()` to avoid double-counting.
- **USDC.e**: Polymarket CTF requires USDC.e (0x2791...), NOT native USDC.
- **Minimum Order**: $1 USDC minimum order value.
- **Token Prices**: Range from 0 to 1. Price 0.65 means the market thinks there's a 65% chance of YES.
