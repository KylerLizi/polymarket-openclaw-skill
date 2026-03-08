---
name: polymarket-trader
description: Polymarket prediction market trading assistant - query markets, execute trades, manage positions, analyze smart money, detect arbitrage
version: 1.0.0
emoji: 🎯
metadata:
  openclaw: {"requires":{"env":["POLY_PRIVATE_KEY","POLYGON_RPC_URLS"],"bins":["node","pnpm","tsx"]},"primaryEnv":"POLY_PRIVATE_KEY"}
---

# Polymarket Trader

A comprehensive Polymarket prediction market assistant. Query markets, execute trades, manage positions, and analyze smart money — all through natural language.

> **WARNING**: This skill operates on real funds on the Polygon blockchain. All trading operations default to DRY-RUN mode and require explicit `--confirm` flag to execute.

## Overview

[Polymarket](https://polymarket.com) is a prediction market platform on the Polygon blockchain where users trade outcome shares (YES/NO) priced between $0 and $1. This skill provides:

- **Market Discovery** — Search, trending markets, orderbook analysis, arbitrage detection, K-lines
- **Wallet Analysis** — Positions, profiles, PnL, activity history
- **Trading** — Limit orders (GTC/GTD), market orders (FAK), order management
- **Account Management** — Redeem resolved positions, clear/sell all positions
- **Smart Money** — Leaderboards, wallet reports, wallet comparison
- **Health Checks** — RPC connectivity, API status, environment validation

## Usage

Example natural language commands:

**Market Queries (no private key needed):**
- "Search for Bitcoin prediction markets"
- "Show me the orderbook for condition ID 0x1234..."
- "Are there any arbitrage opportunities on this market?"
- "Show trending markets"
- "Get K-line data for this market with 1h interval"

**Wallet Queries:**
- "What are my current positions?" (needs private key)
- "Show the profile of wallet 0xABC..."
- "What's my account balance?"
- "Show the weekly leaderboard top 20"

**Trading (needs private key + confirmation):**
- "Buy 50 shares of YES at 0.55"
- "Market sell 100 USDC worth of token 0x..."
- "Cancel all my open orders"
- "Show my open orders"

**Account Management (needs private key + confirmation):**
- "Redeem all resolved positions"
- "Clear all positions (sell or redeem everything)"

**Smart Money Analysis (no private key needed):**
- "Show the top 20 smart money wallets this week"
- "Generate a report for wallet 0xABC..."
- "Compare these two wallets"

## Tools

### 1. Market Query (`scripts/query-market.ts`)
No private key required. Read-only market data.

```bash
tsx scripts/query-market.ts search <keyword>
tsx scripts/query-market.ts detail <slug|conditionId>
tsx scripts/query-market.ts orderbook <conditionId>
tsx scripts/query-market.ts arb <conditionId> [threshold]
tsx scripts/query-market.ts trending [limit]
tsx scripts/query-market.ts klines <conditionId> <interval>
tsx scripts/query-market.ts spread <conditionId>
```

**Parameters:**
- `search`: keyword (string) — market search term
- `detail`: slug or conditionId — market identifier
- `orderbook`: conditionId — shows YES/NO bid/ask/spread
- `arb`: conditionId, threshold (default 0.005) — detect arbitrage
- `trending`: limit (default 10) — number of trending markets
- `klines`: conditionId, interval (1s|5s|15s|30s|1m|5m|15m|30m|1h|4h|12h|1d)
- `spread`: conditionId — realtime spread analysis

### 2. Wallet Query (`scripts/query-wallet.ts`)

```bash
tsx scripts/query-wallet.ts positions <address>
tsx scripts/query-wallet.ts profile <address>
tsx scripts/query-wallet.ts balance                          # needs POLY_PRIVATE_KEY
tsx scripts/query-wallet.ts activity <address> --limit=20
tsx scripts/query-wallet.ts leaderboard --period=week --top=50
```

**Parameters:**
- `positions`: address — wallet address to query
- `profile`: address — wallet PnL, trade stats, smart score
- `balance`: no args, uses POLY_PRIVATE_KEY wallet
- `activity`: address, --limit (default 20)
- `leaderboard`: --period (day|week|month|all), --top (default 50)

### 3. Trade Execute (`scripts/trade-execute.ts`)
Requires POLY_PRIVATE_KEY. **Defaults to DRY-RUN mode.**

```bash
tsx scripts/trade-execute.ts buy <tokenId> <size> <price> --type=GTC [--confirm]
tsx scripts/trade-execute.ts sell <tokenId> <size> <price> --type=GTC [--confirm]
tsx scripts/trade-execute.ts market-buy <tokenId> <amount> [--confirm]
tsx scripts/trade-execute.ts market-sell <tokenId> <amount> [--confirm]
tsx scripts/trade-execute.ts cancel <orderId> [--confirm]
tsx scripts/trade-execute.ts cancel-all [--confirm]
tsx scripts/trade-execute.ts open-orders [marketId]
tsx scripts/trade-execute.ts trades [marketId]
```

**Parameters:**
- `buy/sell`: tokenId, size (shares), price (0-1), --type (GTC|GTD)
- `market-buy/market-sell`: tokenId, amount (USDC)
- `cancel`: orderId
- `open-orders/trades`: optional marketId filter

**Safety:** Without `--confirm`, all write operations only show a preview. Pass `--confirm` to execute for real.

### 4. Account Management (`scripts/manage-account.ts`)
Requires POLY_PRIVATE_KEY. **Defaults to DRY-RUN mode.**

```bash
tsx scripts/manage-account.ts positions
tsx scripts/manage-account.ts redeem [--confirm] [--include-ended]
tsx scripts/manage-account.ts clear [--confirm] [--slippage=0.05] [--include-ended]
```

**Parameters:**
- `positions`: list all positions with status (redeemable/active/ended)
- `redeem`: redeem resolved positions, --include-ended to include ended markets
- `clear`: redeem if resolved, sell if active; --slippage (default 0.05)

### 5. Smart Money Analysis (`scripts/analyze-smartmoney.ts`)
No private key required.

```bash
tsx scripts/analyze-smartmoney.ts leaderboard --period=week --sort=pnl --top=20
tsx scripts/analyze-smartmoney.ts report <address>
tsx scripts/analyze-smartmoney.ts compare <addr1> <addr2> [--period=week]
tsx scripts/analyze-smartmoney.ts smart-list --limit=20
tsx scripts/analyze-smartmoney.ts info <address>
```

### 6. Status Check (`scripts/status-check.ts`)

```bash
tsx scripts/status-check.ts overview    # needs POLY_PRIVATE_KEY
tsx scripts/status-check.ts health      # checks RPC, API, proxy status
```

## Instructions

Follow this decision tree when handling user requests:

```
User Request
├── Query (read-only, no confirmation needed)
│   ├── Market related → query-market.ts (no private key)
│   ├── Other wallet → query-wallet.ts positions/profile (no private key)
│   ├── Own balance → query-wallet.ts balance (needs POLY_PRIVATE_KEY)
│   └── Smart money → analyze-smartmoney.ts (no private key)
│
├── Trading (write operation, MUST confirm with user)
│   ├── Step 1: Use query-market.ts to get market details + orderbook
│   ├── Step 2: Show user: market name, current price, spread, liquidity
│   ├── Step 3: User confirms trade parameters (tokenId, side, amount, price)
│   ├── Step 4: Run with DRY-RUN first (no --confirm) and show preview
│   └── Step 5: Only after user says "confirm/execute", run with --confirm
│
├── Account Management (write operation, MUST confirm)
│   ├── Redeem → manage-account.ts redeem (no --confirm first for preview)
│   └── Clear → manage-account.ts clear (no --confirm first for preview)
│
└── Status
    └── status-check.ts overview/health
```

**Critical Rules:**
1. NEVER add `--confirm` without explicit user approval
2. For trades > $50, show a warning. For trades > $200, require double confirmation
3. Always show DRY-RUN preview before executing any write operation
4. When user asks to trade on a market by name, first search for the market, show the orderbook, then ask for confirmation
5. Present all monetary values clearly with $ prefix and 2 decimal places
6. For orderbook data, explain the mirror property: Buy YES @ P = Sell NO @ (1-P)

**Output Format:** All scripts output JSON to stdout with this structure:
```json
{
  "success": true,
  "command": "query-market search bitcoin",
  "data": { ... },
  "summary": "Found 15 active markets related to 'bitcoin'"
}
```
Parse the JSON and present the `summary` and relevant `data` fields in a user-friendly format.

## Security Notes

- All write operations default to DRY-RUN mode — must pass `--confirm` to execute
- Private key is ONLY read from the `POLY_PRIVATE_KEY` environment variable
- Scripts never print, log, or transmit the private key
- Query operations work without any private key
- No data is sent to third-party services — only Polymarket APIs and configured RPC endpoints
- Polymarket minimum order: $1 USDC

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `POLY_PRIVATE_KEY not set` | Missing env var | Set POLY_PRIVATE_KEY in OpenClaw settings |
| `ECONNREFUSED` | Network/proxy issue | Check POLYGON_RPC_URLS or set USE_PROXY=1 |
| `Insufficient balance` | Not enough USDC.e | Deposit USDC.e to your Polymarket wallet |
| `Orderbook does not exist` | Market closed/ended | Try redeeming instead of selling |
| `Rate limited (429)` | Too many requests | Wait and retry — SDK has built-in rate limiting |

## Configuration Guide

### Required Environment Variables
- `POLY_PRIVATE_KEY` — Your wallet private key (0x... format). Required for trading and balance queries.
- `POLYGON_RPC_URLS` — Comma-separated Polygon RPC endpoints for on-chain operations.

### Optional Environment Variables
- `USE_PROXY=1` — Enable HTTP proxy for API access
- `PROXY_URL` — Custom proxy URL (default: http://127.0.0.1:10081)

### Setup
```bash
cd <skill-directory>
pnpm install
# Verify setup:
tsx scripts/status-check.ts health
```
