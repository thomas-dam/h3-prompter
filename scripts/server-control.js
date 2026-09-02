import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { findAppServers, serverPort, stopAppServers } from '../src/lib/server_process.js';

try {
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const port = serverPort(process.env.PORT || '4567');
  const action = process.argv[2];
  if (action === 'stop') await stopAppServers(port, root);
  else if (action === 'status') {
    const { apps, listeners } = await findAppServers(port, root);
    console.log(apps.length ? `H3 Prompt Writer is running on port ${port} (PID ${apps.map(a => a.pid).join(', ')}).`
      : listeners.length ? `H3 Prompt Writer is not running here; another process uses port ${port}.`
      : `H3 Prompt Writer is stopped on port ${port}.`);
  } else throw new Error('Use npm run stop or npm run status.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
