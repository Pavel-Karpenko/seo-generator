import { registerAs } from '@nestjs/config';

export interface AppConfig {
  port: number;
  nodeEnv: string;
}

export default registerAs('app', (): AppConfig => {
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${process.env['PORT']}". Must be an integer 1-65535.`);
  }

  const validEnvs = ['development', 'production', 'test'] as const;
  if (!validEnvs.includes(nodeEnv as (typeof validEnvs)[number])) {
    throw new Error(
      `Invalid NODE_ENV value: "${nodeEnv}". Must be one of: ${validEnvs.join(', ')}.`,
    );
  }

  return { port, nodeEnv };
});
