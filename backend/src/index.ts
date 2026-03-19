import 'dotenv/config';
import { createApp } from './app';
import { checkConnection } from './db';
import { startRetryWorker } from './webhooks/retryWorker';

const PORT = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  await checkConnection();
  console.log('✓ Database connected');

  const retryWorker = startRetryWorker();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
  });

  const shutdown = (): void => {
    console.log('Shutting down gracefully...');
    clearInterval(retryWorker);
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
