import { Wallet } from 'ethers';

export interface MnemonicWalletDerivation {
  index: number;
  path: string;
  address: string;
  privateKey: string;
  wallet: Wallet;
}

function parseIndexRange(input: string): number[] {
  const trimmed = String(input || '').trim();
  if (!trimmed) return [];

  const parts = trimmed
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  const indices: number[] = [];

  for (const part of parts) {
    const m = part.match(/^\d+\s*-\s*\d+$/);
    if (m) {
      const [aRaw, bRaw] = part.split('-').map(s => s.trim());
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
        throw new Error(`Invalid mnemonic range: ${part}`);
      }
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      for (let i = start; i <= end; i++) indices.push(i);
      continue;
    }

    const n = Number(part);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Invalid mnemonic index: ${part}`);
    }
    indices.push(n);
  }

  // Unique + stable sort
  return Array.from(new Set(indices)).sort((x, y) => x - y);
}

export function deriveWalletsFromMnemonicRange(params: {
  mnemonic: string;
  /** e.g. "0-9" or "0-2,5,7-8" */
  range: string;
  /** Base derivation path without the last index, default: m/44'/60'/0'/0 */
  basePath?: string;
}): MnemonicWalletDerivation[] {
  const mnemonic = String(params.mnemonic || '').trim();
  if (!mnemonic) throw new Error('Mnemonic is required');

  const basePath = String(params.basePath || "m/44'/60'/0'/0").trim();
  if (!basePath) throw new Error('basePath is required');

  const indices = parseIndexRange(params.range);
  if (indices.length === 0) throw new Error('Mnemonic range is empty');

  return indices.map(index => {
    const path = `${basePath}/${index}`;
    const wallet = Wallet.fromMnemonic(mnemonic, path);
    return {
      index,
      path,
      address: wallet.address,
      privateKey: wallet.privateKey,
      wallet,
    };
  });
}
