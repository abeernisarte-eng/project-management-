// Cloudflare Pages Function: routes every /api/* request into the Hono app
// (worker/app.js). The app is created once per isolate; the Hyperdrive
// binding (or a DATABASE_URL secret) reaches it through the request context.
import { createApp } from "../_app.js";

let app = null;

export async function onRequest(context) {
  if (!app) {
    app = createApp(context.env);
  }
  return app.fetch(context.request, context.env, context);
}
