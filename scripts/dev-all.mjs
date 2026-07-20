/**
 * Run the LEDGORA frontend and backend together.
 *
 * Deliberately dependency-free (no concurrently/npm-run-all) and cross-platform:
 * it spawns both npm scripts, prefixes their output, and shuts both down when
 * either exits or you press Ctrl-C.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

const TARGETS = [
  { name: 'api', colour: '[36m', args: ['run', 'server:dev'] },
  { name: 'web', colour: '[35m', args: ['run', 'dev'] },
];

const RESET = '[0m';
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

for (const target of TARGETS) {
  const child = spawn(npm, target.args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: isWindows, // .cmd shims need a shell on Windows
  });
  children.push(child);

  const prefix = `${target.colour}[${target.name}]${RESET} `;
  const forward = (stream, sink) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) sink.write(`${prefix}${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code ?? 0}\n`);
    shutdown(code ?? 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
