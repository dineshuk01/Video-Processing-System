// Runs the user site, the admin dashboard and the queue worker as three separate processes.
//   node scripts/run-split.js dev     # TypeScript + auto-restart on changes (development)
//   node scripts/run-split.js prod    # compiled code (run `npm run build` first)
// Ports: USER_PORT (default 5000) and ADMIN_PORT (default 5001). Both apps read the same data.
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mode = process.argv[2] === 'prod' ? 'prod' : 'dev';
const root = path.join(__dirname, '..');
const userPort = process.env.USER_PORT || '5000';
const adminPort = process.env.ADMIN_PORT || '5001';
const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

const services = [
  { name: 'user  ', env: { APP_MODE: 'user', PORT: userPort }, entry: 'index' },
  { name: 'admin ', env: { APP_MODE: 'admin', PORT: adminPort, USER_APP_URL: process.env.USER_APP_URL || `http://localhost:${userPort}/` }, entry: 'index' },
  { name: 'worker', env: {}, entry: 'worker' },
];

const children = services.map((s) => {
  const args = mode === 'prod'
    ? { cmd: process.execPath, argv: [path.join('dist', `${s.entry}.js`)] }
    : { cmd: bin('nodemon'), argv: ['--watch', 'src', '-e', 'ts', '--exec', 'ts-node', path.join('src', `${s.entry}.ts`)] };
  const child = spawn(args.cmd, args.argv, { cwd: root, env: { ...process.env, ...s.env }, shell: process.platform === 'win32' && mode === 'dev' });
  const out = (stream, target) => stream.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => target.write(`[${s.name}] ${l}\n`)));
  out(child.stdout, process.stdout); out(child.stderr, process.stderr);
  child.on('exit', (code) => { console.log(`[${s.name}] exited (${code})`); stop(code || 0); });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return; stopping = true;
  children.forEach((c) => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F']); else c.kill('SIGTERM'); } catch { /* already gone */ } });
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));

console.log(`User site:       http://localhost:${userPort}/\nAdmin dashboard: http://localhost:${adminPort}/admin/\n`);
