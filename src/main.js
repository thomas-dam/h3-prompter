import { createServer, ensureCache } from "./server.js";

const PORT = process.env.PORT || 4567;

await ensureCache();

const app = createServer();

app.listen(PORT, () => {
  console.log(`H3 Prompt Writer running at http://127.0.0.1:${PORT}`);
  console.log(`UI:  http://127.0.0.1:${PORT}/`);
  console.log(`API: http://127.0.0.1:${PORT}/h3studio/status`);
});