import cors from 'cors';
import express, { Application, NextFunction, Request, Response } from 'express';
import { errorHandler } from './api/middleware/errorHandler';
import { notFound } from './api/middleware/notFound';
import apiRouter from './api/routes';

export function createApp(): Application {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Minimal request logging in non-production environments.
  if (process.env.NODE_ENV !== 'production') {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      console.log(`  → ${req.method} ${req.path}`);
      next();
    });
  }

  // Liveness probe — no auth, no DB round-trip.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/v1', apiRouter);

  // 404 and error handlers must be registered last.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
