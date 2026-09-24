import { Hono } from 'hono';
import type { WebContext } from './context.js';
import { createIndexRoute } from './routes/index.js';
import { createDetailRoute } from './routes/detail.js';
import { createCommunityRoute } from './routes/community.js';
import { createJevRoute } from './routes/jev.js';

export function createApp(ctx: WebContext): Hono {
  const app = new Hono();
  app.route('/', createIndexRoute(ctx));
  app.route('/', createDetailRoute(ctx));
  app.route('/', createCommunityRoute(ctx));
  app.route('/', createJevRoute(ctx));
  return app;
}
