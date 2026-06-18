import { defineConfig } from 'vitest/config';
import { cloudflarePool } from '@cloudflare/vitest-pool-workers';
export default defineConfig({test:{pool:cloudflarePool({wrangler:{configPath:'./wrangler.toml'},miniflare:{d1Databases:['DB'],r2Buckets:['FILINGS_BUCKET'],kvNamespaces:['CONFIG_KV'],queueProducers:{PARSE_QUEUE:'filing-parse-queue'},bindings:{ADMIN_PASSWORD:'test',SEC_USER_AGENT_EMAIL:'test@example.com'}}}),include:['test/**/*.test.ts']}} as any);
