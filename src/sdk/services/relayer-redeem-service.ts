/**
 * RelayerRedeemService - Gasless redemption via Polymarket Relayer
 *
 * This service uses @polymarket/builder-relayer-client to redeem resolved positions
 * without paying gas. The Relayer pays gas on behalf of the user.
 *
 * Requires Builder API credentials (key, secret, passphrase) from Polymarket.
 *
 * @example
 * ```typescript
 * const service = new RelayerRedeemService({
 *   privateKey: '0x...',
 *   rpcUrl: 'https://polygon-rpc.com',
 *   builderApiKey: 'your_key',
 *   builderApiSecret: 'your_secret',
 *   builderApiPassphrase: 'your_passphrase',
 * });
 *
 * // Redeem a single condition
 * const result = await service.redeemByConditionId(conditionId);
 *
 * // Redeem all redeemable positions
 * const results = await service.redeemAll();
 * ```
 */

import { Contract, ethers } from 'ethers';
import { createWalletClient, http, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { RelayClient, OperationType } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';

// ===== Constants =====

const RELAYER_URL = 'https://relayer-v2.polymarket.com/';
const POLYGON_CHAIN_ID = 137;

const SAFE_PROXY_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';
const SAFE_PROXY_FACTORY_ABI = ['function computeProxyAddress(address owner) view returns (address)'];

const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const ERC1155_TRANSFER_SINGLE_TOPIC = ethers.utils.id('TransferSingle(address,address,address,uint256,uint256)');
const ERC1155_TRANSFER_BATCH_TOPIC = ethers.utils.id('TransferBatch(address,address,address,uint256[],uint256[])');

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const NEG_RISK_ADAPTER_ABI = [
  // NegRiskAdapter.redeemPositions takes (conditionId, amounts) where amounts = [yesAmount, noAmount]
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

// ===== Types =====

export interface RelayerRedeemServiceConfig {
  /** Private key for signing (EOA owner of the Safe) */
  privateKey: string;
  /** RPC URL for Polygon */
  rpcUrl: string;
  /** Optional: additional RPC URLs for failover */
  rpcUrls?: string[];
  /** Builder API Key */
  builderApiKey: string;
  /** Builder API Secret */
  builderApiSecret: string;
  /** Builder API Passphrase */
  builderApiPassphrase: string;
  /** Optional: explicit Safe address (if not provided, computed from owner) */
  safeAddress?: string;
}

export interface RelayerRedeemResult {
  success: boolean;
  conditionId: string;
  txHash?: string;
  winningOutcome?: 'YES' | 'NO';
  tokensRedeemed?: string;
  error?: string;
}

export interface MarketResolution {
  resolved: boolean;
  winningOutcome?: 'YES' | 'NO';
}

export interface TokenIds {
  yesTokenId: string;
  noTokenId: string;
}

// ===== Service =====

export class RelayerRedeemService {
  private readonly privateKey: string;
  private readonly rpcUrl: string;
  private readonly provider: ethers.providers.Provider;
  private readonly ownerAddress: string;
  private readonly builderConfig: BuilderConfig;
  private readonly relayClient: RelayClient;
  private readonly ctf: Contract;
  private readonly ctfIface: ethers.utils.Interface;

  private safeAddress: string | null = null;
  private readonly explicitSafeAddress?: string;

  constructor(config: RelayerRedeemServiceConfig) {
    this.privateKey = config.privateKey;
    this.rpcUrl = config.rpcUrl;
    this.explicitSafeAddress = config.safeAddress;

    // Build RPC URLs list
    const rpcUrls = (config.rpcUrls?.length ? config.rpcUrls : [config.rpcUrl])
      .map(u => String(u || '').trim())
      .filter(Boolean);

    if (!rpcUrls.length) {
      throw new Error('Missing RPC URL');
    }

    const POLYGON_NETWORK: ethers.providers.Network = { name: 'matic', chainId: POLYGON_CHAIN_ID };

    // Create provider
    if (rpcUrls.length > 1) {
      this.provider = new ethers.providers.FallbackProvider(
        rpcUrls.map(url => new ethers.providers.StaticJsonRpcProvider(url, POLYGON_NETWORK))
      );
    } else {
      this.provider = new ethers.providers.StaticJsonRpcProvider(rpcUrls[0], POLYGON_NETWORK);
    }

    // Get owner address from private key
    const wallet = new ethers.Wallet(config.privateKey);
    this.ownerAddress = ethers.utils.getAddress(wallet.address);

    // Create Builder config
    this.builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.builderApiKey,
        secret: config.builderApiSecret,
        passphrase: config.builderApiPassphrase,
      },
    });

    // Create viem signer for RelayClient
    const account = privateKeyToAccount(config.privateKey as Hex);
    const viemSigner = createWalletClient({
      account,
      chain: polygon,
      transport: http(rpcUrls[0]),
    });

    // Create RelayClient
    this.relayClient = new RelayClient(
      RELAYER_URL,
      POLYGON_CHAIN_ID,
      viemSigner,
      this.builderConfig
    );

    // Create CTF contract instance
    this.ctf = new Contract(CTF_CONTRACT, CTF_ABI, this.provider);
    this.ctfIface = new ethers.utils.Interface(CTF_ABI);
  }

  /**
   * Get the Safe (proxy) address for this service
   */
  async getSafeAddress(): Promise<string> {
    if (this.safeAddress) return this.safeAddress;

    if (this.explicitSafeAddress) {
      this.safeAddress = ethers.utils.getAddress(this.explicitSafeAddress);
      return this.safeAddress;
    }

    const factory = new Contract(SAFE_PROXY_FACTORY, SAFE_PROXY_FACTORY_ABI, this.provider);
    const addr: string = await factory.computeProxyAddress(this.ownerAddress);
    this.safeAddress = ethers.utils.getAddress(addr);
    return this.safeAddress;
  }

  /**
   * Get the EOA owner address
   */
  getOwnerAddress(): string {
    return this.ownerAddress;
  }

  /**
   * Check if a market is resolved and get the winning outcome
   */
  async getMarketResolution(conditionId: string): Promise<MarketResolution> {
    const [yesNumerator, noNumerator, denom] = await Promise.all([
      this.ctf.payoutNumerators(conditionId, 0),
      this.ctf.payoutNumerators(conditionId, 1),
      this.ctf.payoutDenominator(conditionId),
    ]);

    const resolved = ethers.BigNumber.from(denom).gt(0);
    if (!resolved) return { resolved: false };

    const yesGt0 = ethers.BigNumber.from(yesNumerator).gt(0);
    const noGt0 = ethers.BigNumber.from(noNumerator).gt(0);
    if (yesGt0 && !noGt0) return { resolved: true, winningOutcome: 'YES' };
    if (noGt0 && !yesGt0) return { resolved: true, winningOutcome: 'NO' };
    return { resolved: true };
  }

  /**
   * Get the balance of a specific token for the Safe address
   */
  async getTokenBalance(tokenId: string): Promise<ethers.BigNumber> {
    const safeAddress = await this.getSafeAddress();
    return this.ctf.balanceOf(safeAddress, tokenId);
  }

  /**
   * Redeem a resolved position by conditionId
   *
   * @param conditionId - The condition ID of the market
   * @param tokenIds - Optional token IDs (yesTokenId, noTokenId). If not provided, uses [1,2] indexSets.
   * @returns RedeemResult with success status and transaction hash
   */
  async redeemByConditionId(
    conditionId: string,
    tokenIds?: TokenIds,
    opts?: { negativeRisk?: boolean; outcomeSlotCount?: number }
  ): Promise<RelayerRedeemResult> {
    try {
      // Check resolution
      const resolution = await this.getMarketResolution(conditionId);
      if (!resolution.resolved) {
        return {
          success: false,
          conditionId,
          error: 'Market not resolved',
        };
      }

      // Check balance if tokenIds provided
      let tokensRedeemed: string | undefined;
      if (tokenIds && resolution.winningOutcome) {
        const winningTokenId = resolution.winningOutcome === 'YES'
          ? tokenIds.yesTokenId
          : tokenIds.noTokenId;
        const balance = await this.getTokenBalance(winningTokenId);
        tokensRedeemed = balance.lte(0) ? '0' : ethers.utils.formatUnits(balance, 6);
      }

      // Build redeem transaction
      // NOTE: For neg-risk markets, Polymarket uses a dedicated adapter contract.
      // NegRiskAdapter.redeemPositions(conditionId, amounts) where amounts = [yesAmount, noAmount]
      const isNegRisk = Boolean(opts?.negativeRisk);

      let tx: { to: string; data: string; value: string; operation: OperationType };

      if (isNegRisk) {
        // For negativeRisk markets, we need to pass the actual token amounts to redeem
        // NegRiskAdapter.redeemPositions(bytes32 _conditionId, uint256[] _amounts)
        // _amounts = [yesTokenAmount, noTokenAmount]
        const safeAddress = await this.getSafeAddress();
        let yesAmount = ethers.BigNumber.from(0);
        let noAmount = ethers.BigNumber.from(0);

        if (tokenIds) {
          const [yesBal, noBal] = await Promise.all([
            this.ctf.balanceOf(safeAddress, tokenIds.yesTokenId).catch(() => ethers.BigNumber.from(0)),
            this.ctf.balanceOf(safeAddress, tokenIds.noTokenId).catch(() => ethers.BigNumber.from(0)),
          ]);
          yesAmount = yesBal;
          noAmount = noBal;
        }

        // If both balances are 0, skip redeem
        if (yesAmount.lte(0) && noAmount.lte(0)) {
          return {
            success: false,
            conditionId,
            error: 'No tokens to redeem (balance is 0)',
          };
        }

        tx = {
          to: NEG_RISK_ADAPTER,
          data: new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI).encodeFunctionData('redeemPositions', [
            conditionId,
            [yesAmount, noAmount],
          ]),
          value: '0',
          operation: OperationType.Call,
        };
      } else {
        // Standard CTF market: use indexSets [1, 2] to let CTF contract settle whichever outcome won
        const standardIndexSets = [1, 2];
        tx = {
          to: CTF_CONTRACT,
          data: this.ctfIface.encodeFunctionData('redeemPositions', [
            USDC_E_CONTRACT,
            ethers.constants.HashZero,
            conditionId,
            standardIndexSets,
          ]),
          value: '0',
          operation: OperationType.Call,
        };
      }

      // Execute via Relayer (gasless)
      const response = await this.relayClient.execute(
        [tx],
        `Redeem ${conditionId.slice(0, 10)}...`
      );
      const receipt = await response.wait();

      if (receipt && receipt.transactionHash) {
        const txHash = receipt.transactionHash;
        try {
          const onchainReceipt = await this.provider.waitForTransaction(txHash, 1, 120_000);
          if (!onchainReceipt) {
            return {
              success: false,
              conditionId,
              txHash,
              winningOutcome: resolution.winningOutcome,
              tokensRedeemed,
              error: 'Transaction not confirmed yet',
            };
          }

          if (onchainReceipt.status !== 1) {
            return {
              success: false,
              conditionId,
              txHash,
              winningOutcome: resolution.winningOutcome,
              tokensRedeemed,
              error: 'Transaction reverted on-chain',
            };
          }

          // Success should mean actual ERC-1155 transfers happened (redeem executed).
          // Some transactions can be mined with status=1 but effectively do nothing.
          const hasErc1155Transfer = (onchainReceipt.logs || []).some(l => {
            const addr = String((l as any)?.address || '').toLowerCase();
            if (addr !== String(CTF_CONTRACT).toLowerCase()) return false;
            const topics = (l as any)?.topics as string[] | undefined;
            const t0 = topics?.[0];
            return t0 === ERC1155_TRANSFER_SINGLE_TOPIC || t0 === ERC1155_TRANSFER_BATCH_TOPIC;
          });

          if (!hasErc1155Transfer) {
            return {
              success: false,
              conditionId,
              txHash,
              winningOutcome: resolution.winningOutcome,
              tokensRedeemed,
              error: 'No ERC-1155 transfer logs found (redeem not executed)',
            };
          }

          return {
            success: true,
            conditionId,
            txHash,
            winningOutcome: resolution.winningOutcome,
            tokensRedeemed,
          };
        } catch (e: any) {
          return {
            success: false,
            conditionId,
            txHash,
            winningOutcome: resolution.winningOutcome,
            tokensRedeemed,
            error: e?.message || String(e),
          };
        }
      } else {
        return {
          success: false,
          conditionId,
          winningOutcome: resolution.winningOutcome,
          error: 'No transaction hash returned from Relayer',
        };
      }
    } catch (e: any) {
      return {
        success: false,
        conditionId,
        error: e?.message || String(e),
      };
    }
  }

  /**
   * Redeem by token IDs (convenience method matching OnchainService interface)
   */
  async redeemByTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    outcome?: 'YES' | 'NO'
  ): Promise<RelayerRedeemResult> {
    return this.redeemByConditionId(conditionId, tokenIds);
  }

  /**
   * Check if the service is properly configured
   */
  isConfigured(): boolean {
    return !!(
      this.privateKey &&
      this.rpcUrl &&
      this.builderConfig
    );
  }
}

// ===== Factory function =====

export interface RelayerRedeemServiceFromEnvConfig {
  /** Override RPC URL from env */
  rpcUrl?: string;
  /** Override RPC URLs from env */
  rpcUrls?: string[];
  /** Override Safe address from env */
  safeAddress?: string;
}

/**
 * Create RelayerRedeemService from environment variables
 *
 * Required env vars:
 * - POLY_PRIVATE_KEY
 * - POLY_BUILDER_API_KEY
 * - POLY_BUILDER_API_SECRET
 * - POLY_BUILDER_API_PASSPHRASE
 * - POLYGON_RPC_URL or POLYGON_RPC_URLS
 *
 * Optional:
 * - POLY_FUNDER_ADDRESS (explicit Safe address)
 */
export function createRelayerRedeemServiceFromEnv(
  config?: RelayerRedeemServiceFromEnvConfig
): RelayerRedeemService {
  const privateKey = String(process.env.POLY_PRIVATE_KEY || '').trim();
  if (!privateKey) {
    throw new Error('Missing POLY_PRIVATE_KEY');
  }

  const builderApiKey = String(process.env.POLY_BUILDER_API_KEY || '').trim();
  const builderApiSecret = String(process.env.POLY_BUILDER_API_SECRET || '').trim();
  const builderApiPassphrase = String(process.env.POLY_BUILDER_API_PASSPHRASE || '').trim();
  if (!builderApiKey || !builderApiSecret || !builderApiPassphrase) {
    throw new Error('Missing POLY_BUILDER_API_KEY, POLY_BUILDER_API_SECRET, or POLY_BUILDER_API_PASSPHRASE');
  }

  // Parse RPC URLs
  let rpcUrl = config?.rpcUrl || String(process.env.POLYGON_RPC_URL || '').trim();
  let rpcUrls = config?.rpcUrls;

  if (!rpcUrls) {
    const rpcUrlsEnv = String(process.env.POLYGON_RPC_URLS || '').trim();
    if (rpcUrlsEnv) {
      rpcUrls = rpcUrlsEnv.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  if (!rpcUrl && rpcUrls?.length) {
    rpcUrl = rpcUrls[0];
  }

  if (!rpcUrl) {
    throw new Error('Missing POLYGON_RPC_URL or POLYGON_RPC_URLS');
  }

  const safeAddress = config?.safeAddress || String(process.env.POLY_FUNDER_ADDRESS || '').trim() || undefined;

  return new RelayerRedeemService({
    privateKey,
    rpcUrl,
    rpcUrls,
    builderApiKey,
    builderApiSecret,
    builderApiPassphrase,
    safeAddress,
  });
}
