import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const requiredFiles = [
  'AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md',
  '.gitignore', '.gitattributes', '.editorconfig', '.nvmrc', 'package.json',
  '.github/workflows/ci.yml', 'docs/implementation-plan.md',
  'docs/architecture.md', 'docs/design-evidence.md', 'docs/repository-ownership.md',
  'extension/README.md', 'src/README.md', 'adapters/README.md', 'schemas/README.md',
  'systemd/README.md', 'install/README.md', 'scripts/README.md', 'tests/README.md',
  'tests/fixtures/README.md', 'scripts/check-repository.mjs', 'tests/repository.test.mjs',
];

const skippedDirectories = new Set([
  '.git', 'node_modules', 'coverage', 'dist', 'build', '.cache', '.serena',
  '.codex', '.agents', 'artifacts', 'state', 'runtime', 'runs', 'backups',
  'downloads', 'private', 'local',
]);

function contained(root, target) {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

// Checks ordinary inline Markdown links, not external URLs or fragment targets.
export function checkMarkdown(root, path, content) {
  const errors = [];
  const label = relative(root, path);
  if (/Warning: truncated output|Total output lines: \d+|\d+ tokens truncated/.test(content)) {
    errors.push(`${label}: captured tool truncation marker; restore the complete source`);
  }
  let fence = null;
  const prose = [];
  for (const [index, line] of content.split('\n').entries()) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) {
        fence = delimiter[1];
      } else if (delimiter[1][0] === fence[0]
        && delimiter[1].length >= fence.length && delimiter[2].trim() === '') {
        fence = null;
      }
    } else if (!fence) {
      prose.push([index + 1, line]);
    }
  }
  if (fence) errors.push(`${label}: unclosed code fence`);
  if (!content.endsWith('\n')) errors.push(`${label}: missing final newline`);

  for (const [lineNumber, line] of prose) {
    for (const match of line.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const href = match[1].trim();
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
      let target;
      try {
        target = resolve(dirname(path), decodeURIComponent(href.split(/[?#]/)[0]));
      } catch {
        errors.push(`${label}:${lineNumber}: invalid link encoding`);
        continue;
      }
      if (!contained(root, target)) {
        errors.push(`${label}:${lineNumber}: local link escapes repository`);
      } else if (!existsSync(target)) {
        errors.push(`${label}:${lineNumber}: missing local link: ${href}`);
      } else if (!contained(realpathSync(root), realpathSync(target))) {
        errors.push(`${label}:${lineNumber}: local link resolves outside repository`);
      }
    }
  }
  return errors;
}

export function checkRepository(root = repositoryRoot) {
  root = realpathSync(root);
  const errors = [];
  for (const path of requiredFiles) {
    const target = resolve(root, path);
    if (!existsSync(target) || !lstatSync(target).isFile()
      || !contained(root, realpathSync(target))) {
      errors.push(`Missing regular repository file: ${path}`);
    }
  }
  // Missing inputs should produce useful diagnostics rather than read errors.
  if (errors.length) return errors;

  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const nodeVersion = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
    if (pkg.name !== 'miyo-catchup' || pkg.type !== 'module'
      || pkg.private !== true || pkg.license !== 'UNLICENSED') {
      errors.push('package.json: unexpected package identity or publication policy');
    }
    if (nodeVersion !== '22.23.2' || pkg.engines?.node !== '>=22.23.2 <23') {
      errors.push('Node version pin and package engine must match the qualified baseline');
    }
    if (pkg.scripts?.check !== 'node scripts/check-repository.mjs'
      || pkg.scripts?.test !== 'node --test tests/*.test.mjs') {
      errors.push('package.json: documented check/test commands are missing');
    }
  } catch (error) {
    errors.push(`Invalid package metadata: ${error.message}`);
  }

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skippedDirectories.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`${relative(root, path)}: repository checks do not follow symlinks`);
      } else if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        errors.push(...checkMarkdown(root, path, readFileSync(path, 'utf8')));
      }
    }
  }
  walk(root);

  const plan = readFileSync(resolve(root, 'docs/implementation-plan.md'), 'utf8');
  for (let number = 1; number <= 14; number += 1) {
    if (!new RegExp(`^## ${number}\\. `, 'm').test(plan)) {
      errors.push(`Plan is missing section ${number}`);
    }
  }
  for (const [prefix, count] of [['R', 16], ['AC', 16], ['I', 8], ['T', 10]]) {
    for (let number = 1; number <= count; number += 1) {
      const id = `${prefix}${String(number).padStart(2, '0')}`;
      const declaration = prefix === 'T' ? `### ${id} —`
        : prefix === 'I' ? `- ${id}:` : `| ${id} |`;
      if (!plan.includes(declaration)) errors.push(`Plan is missing declaration ${id}`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkRepository();
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('Repository structure checks passed (run npm test for offline qualification).');
  }
}
