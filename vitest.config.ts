import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: 'silent', TABLE_NAME: 'jobfinder-test', TELEGRAM_CHAT_ID: '123456789', AWS_REGION: 'eu-central-1' },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/contracts/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          // DynamoDB Local runs in Docker; see test/integration/README.md
          testTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
