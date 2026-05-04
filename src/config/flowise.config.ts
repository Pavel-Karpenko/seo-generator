import { registerAs } from '@nestjs/config';

export interface FlowiseConfig {
  baseUrl: string;
  chatflowId: string;
  apiKey: string;
  timeoutMs: number;
}

export default registerAs('flowise', (): FlowiseConfig => {
  const baseUrl = process.env['FLOWISE_BASE_URL'];
  const chatflowId = process.env['FLOWISE_CHATFLOW_ID'];
  const apiKey = process.env['FLOWISE_API_KEY'] ?? '';
  const timeoutMs = parseInt(process.env['FLOWISE_TIMEOUT_MS'] ?? '90000', 10);

  if (!baseUrl) {
    throw new Error('FLOWISE_BASE_URL environment variable is required.');
  }

  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`FLOWISE_BASE_URL is not a valid URL: "${baseUrl}".`);
  }

  if (!chatflowId) {
    throw new Error('FLOWISE_CHATFLOW_ID environment variable is required.');
  }

  if (isNaN(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new Error(
      `FLOWISE_TIMEOUT_MS must be between 1000 and 300000. Got: "${process.env['FLOWISE_TIMEOUT_MS']}".`,
    );
  }

  return { baseUrl, chatflowId, apiKey, timeoutMs };
});
