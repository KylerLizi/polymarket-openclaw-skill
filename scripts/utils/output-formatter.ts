/**
 * JSON 结构化输出工具
 * 所有脚本 stdout 统一格式
 */

interface SuccessOutput {
  success: true;
  command: string;
  data: any;
  summary: string;
}

interface ErrorOutput {
  success: false;
  command: string;
  error: string;
  hint?: string;
}

/**
 * 输出成功结果
 */
export function success(command: string, data: any, summary: string): void {
  const output: SuccessOutput = { success: true, command, data, summary };
  console.log(JSON.stringify(output, null, 2));
}

/**
 * 输出错误结果
 */
export function error(command: string, err: string, hint?: string): void {
  const output: ErrorOutput = { success: false, command, error: err, ...(hint ? { hint } : {}) };
  console.log(JSON.stringify(output, null, 2));
}

/**
 * 包裹执行函数，统一错误处理
 */
export async function run(command: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    const msg = e?.message || String(e);
    let hint: string | undefined;

    if (msg.includes('POLY_PRIVATE_KEY')) {
      hint = '请设置 POLY_PRIVATE_KEY 环境变量（0x 开头的私钥）';
    } else if (msg.includes('POLYGON_RPC_URLS')) {
      hint = '请设置 POLYGON_RPC_URLS 环境变量（逗号分隔的 RPC 端点）';
    } else if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
      hint = '网络连接失败，请检查 RPC 端点或代理配置（USE_PROXY=1）';
    } else if (msg.includes('insufficient funds') || msg.includes('Insufficient balance')) {
      hint = '余额不足，请确认账户有足够的 USDC.e';
    }

    error(command, msg, hint);
    process.exit(1);
  }
}
