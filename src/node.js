import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
const port = +(process.env.PORT || 8787);
serve({ fetch: createApp(process.env).fetch, port });
console.log(`ItalyCheck on http://localhost:${port}`);
