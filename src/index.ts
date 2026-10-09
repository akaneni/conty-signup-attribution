import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const windowDays = Number(process.env.ATTRIBUTION_WINDOW_DAYS ?? 7);
if (!Number.isFinite(windowDays) || windowDays <= 0) {
  throw new Error("ATTRIBUTION_WINDOW_DAYS deve ser um número positivo.");
}
const port = Number(process.env.PORT ?? 3006);
const app = createApp({ db: openDb(process.env.DB_PATH ?? ":memory:"), clock: () => Date.now(), windowDays });
serve({ fetch: app.fetch, port }, () => console.log(`signup-attribution em http://localhost:${port} (janela de ${windowDays} dias)`));
