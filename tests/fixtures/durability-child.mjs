import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDurableDatabase, transaction } from '../../src/sqlite.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[index + 1]);
}

const action = args.get('action');
const dbPath = args.get('db');
const readyPath = args.get('ready');
const lockReadyPath = args.get('lock-ready');

function signal(pathname, value = 'ready\n') {
  if (pathname) writeFileSync(pathname, value, { mode: 0o600 });
}

function waitForever() {
  setInterval(() => {}, 60_000);
}

if (action === 'uncommitted-transaction') {
  if (!dbPath) throw new Error('missing db');
  const db = openDurableDatabase({ path: dbPath, root: args.get('root'), trustedBoundary: args.get('root') });
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO events (value) VALUES (?)').run(args.get('value') ?? 'uncommitted');
  signal(readyPath);
  waitForever();
} else if (action === 'committed-transaction') {
  if (!dbPath) throw new Error('missing db');
  const db = openDurableDatabase({ path: dbPath, root: args.get('root'), trustedBoundary: args.get('root') });
  transaction(db, (connection) => {
    connection.prepare('INSERT INTO events (value) VALUES (?)').run(args.get('value') ?? 'committed');
  });
  signal(readyPath);
  // Keep the process alive so the parent can terminate it abruptly after the
  // commit marker. This proves a committed transaction survives a crash too.
  waitForever();
} else if (action === 'hold') {
  signal(lockReadyPath ?? readyPath);
  waitForever();
} else if (action === 'raw-uncommitted') {
  if (!dbPath) throw new Error('missing db');
  const db = new DatabaseSync(dbPath, { allowExtension: false });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA user_version = 99; BEGIN IMMEDIATE');
  db.prepare('INSERT INTO events (value) VALUES (?)').run(args.get('value') ?? 'crash-left');
  signal(readyPath);
  waitForever();
} else {
  throw new Error(`unknown action: ${action}`);
}
