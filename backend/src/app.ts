import cors from 'cors';
import express, { Application, NextFunction, Request, Response } from 'express';
import { errorHandler } from './api/middleware/errorHandler';
import { notFound } from './api/middleware/notFound';
import apiRouter from './api/routes';

export function createApp(): Application {
  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    methods: ['GET', 'POST'],
  }));
  app.use(express.json({ limit: '1mb' }));

  // Request/response logging with timing in non-production environments.
  if (process.env.NODE_ENV !== 'production') {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        console.log(`  → ${req.method} ${req.path} ${res.statusCode} (${Date.now() - start}ms)`);
      });
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
