import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

const exec = promisify(execFile);
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function serverPort(value = '4567') {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return Number(value);
}

async function command(file, args) {
  try { return (await exec(file, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    if (error.code === 1 && !error.stderr?.trim()) return '';
    throw new Error(`Cannot inspect server processes with ${file}: ${error.message}`);
  }
}

export async function appProcess(pid, root) {
  if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) return null;
  const executable = await command('ps', ['-p', String(pid), '-o', 'comm=']);
  if (!['node', 'nodejs'].includes(basename(executable))) return null;
  const args = await command('ps', ['-p', String(pid), '-o', 'command=']);
  const entry = new RegExp(`(?:^|\\s)(?:src/main\\.js|${escaped(join(root, 'src/main.js'))})(?:\\s|$)`);
  if (!entry.test(args)) return null;
  const cwd = process.platform === 'linux' ? await readlink(`/proc/${pid}/cwd`).catch(() => '')
    : (await command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).split('\n').find(line => line.startsWith('n'))?.slice(1);
  if (!cwd || await realpath(cwd).catch(() => '') !== root) return null;
  const started = await command('ps', ['-p', String(pid), '-o', 'lstart=']);
  return started ? { pid, started } : null;
}

export async function findAppServers(port, root) {
  const output = await command('lsof', ['-nP', `-iTCP:${serverPort(port)}`, '-sTCP:LISTEN', '-t']);
  const pids = [...new Set(output.split(/\s+/).filter(Boolean).map(Number))];
  const matches = await Promise.all(pids.map(pid => appProcess(pid, root)));
  return { apps: matches.filter(Boolean), listeners: pids };
}

export async function stopAppServers(port, root, log = console.log) {
  const { apps, listeners } = await findAppServers(port, root);
  if (!apps.length) {
    if (listeners.length) throw new Error(`Port ${port} belongs to another process. Nothing was stopped.`);
    log(`H3 Prompt Writer is already stopped on port ${port}.`);
    return;
  }
  for (const app of apps) {
    // Recheck immediately before signaling; don't trust a stale PID or a port alone.
    const current = await appProcess(app.pid, root);
    if (current?.started !== app.started) throw new Error('The server process changed during inspection. Nothing further was stopped; run the command again.');
    log(`Stopping H3 Prompt Writer (PID ${app.pid}, port ${port})…`);
    try { process.kill(app.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const remaining = await findAppServers(port, root);
    const alive = await Promise.all(apps.map(app => appProcess(app.pid, root)));
    if (!remaining.apps.length && alive.every((info, i) => !info || info.started !== apps[i].started)) {
      log('H3 Prompt Writer stopped. Saved projects and model settings were not deleted.');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The app did not finish shutting down within 12 seconds. No force-kill was sent; inspect the terminal/log before trying again.');
}
