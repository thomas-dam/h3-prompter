import { createServer, ensureCache } from "./server.js";
import { networkInterfaces } from "node:os";

const PORT = process.env.PORT || 4567;
const HOST = process.env.HOST || "127.0.0.1";

await ensureCache();

const app = createServer();

app.listen(PORT, HOST, () => {
  const host = HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`H3 Prompt Writer listening on ${host}:${PORT}`);
  console.log(`UI: http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : host}:${PORT}/`);
  if (HOST === "0.0.0.0" || HOST === "::") {
    for (const iface of Object.values(networkInterfaces()).flat()) {
      if (iface && !iface.internal && iface.family === "IPv4") console.log(`Network: http://${iface.address}:${PORT}/`);
    }
    console.warn("No login: only expose this service to trusted networks and devices.");
  }
});
