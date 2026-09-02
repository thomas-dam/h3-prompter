import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appProcess, serverPort } from '../src/lib/server_process.js';

const exec = promisify(execFile);
const repo = await fs.realpath(fileURLToPath(new URL('../', import.meta.url)));

test('stop identifies this app, frees its port, is repeatable and leaves saved data alone', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'h3-stop-'));
  const reserve = createServer();reserve.listen(0, '127.0.0.1');await once(reserve, 'listening');
  const port = reserve.address().port;await new Promise(resolve => reserve.close(resolve));
  assert.notEqual(port, 4567, 'Never stop the user app during tests.');
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), H3_CACHE_ROOT: join(root, 'cache'), H3_DATA_DIR: join(root, 'projects'), H3_SETTINGS_PATH: join(root, 'settings.json') };
  await fs.writeFile(env.H3_SETTINGS_PATH, '{"lmstudio_model_id":"saved-model"}');
  await fs.mkdir(env.H3_DATA_DIR);await fs.writeFile(join(env.H3_DATA_DIR, 'saved-project'), 'keep');
  const child = spawn(process.execPath, ['src/main.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';child.stdout.on('data', chunk => output += chunk);child.stderr.on('data', chunk => output += chunk);
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');await exited;await fs.rm(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 8000;
  while (!output.includes('listening on')) {
    assert.ok(Date.now() < deadline && child.exitCode === null, output || 'App did not start.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const base = `http://127.0.0.1:${port}`;
  const control = action => exec(process.execPath, ['scripts/server-control.js', action], { cwd: repo, env, timeout: 18000 });
  assert.equal((await fetch(base + '/h3studio/status')).status, 200);
  assert.equal((await appProcess(child.pid, repo)).pid, child.pid);
  assert.equal(await appProcess(child.pid, root), null);
  assert.match((await control('status')).stdout, new RegExp(`running.*${port}.*${child.pid}`));
  assert.match((await control('stop')).stdout, /H3 Prompt Writer stopped/);await exited;
  await assert.rejects(fetch(base + '/h3studio/status'));
  assert.equal(await fs.readFile(join(env.H3_DATA_DIR, 'saved-project'), 'utf8'), 'keep');
  assert.equal(JSON.parse(await fs.readFile(env.H3_SETTINGS_PATH)).lmstudio_model_id, 'saved-model');
  assert.match((await control('stop')).stdout, /already stopped/);
  assert.match((await control('status')).stdout, /is stopped/);
});

test('stop refuses unrelated listeners and invalid ports without signaling them', async t => {
  const other = createServer((_req, res) => res.end('unrelated'));
  other.listen(0, '127.0.0.1');await once(other, 'listening');
  t.after(() => new Promise(resolve => other.close(resolve)));
  const port = other.address().port;
  await assert.rejects(exec(process.execPath, ['scripts/server-control.js', 'stop'], { cwd: repo, env: { ...process.env, PORT: String(port) } }), error => /another process.*Nothing was stopped/.test(error.stderr));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
  for (const port of ['0', '-1', '65536', '4567; killall node', 'NaN']) assert.throws(() => serverPort(port), /PORT must/);
});
