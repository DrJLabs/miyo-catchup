import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkMarkdown, checkRepository } from '../scripts/check-repository.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'miyo-catchup-scaffold-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'README.md'), '# Synthetic fixture\n');
  return { root, path: join(root, 'docs', 'example.md') };
}

test('repository scaffold and declared requirement IDs are intact', () => {
  assert.deepEqual(checkRepository(), []);
});

test('links within the repository, external URLs and fragments are accepted', (t) => {
  const { root, path } = fixture(t);
  const text = '[Root](../README.md) [Web](https://example.com) [Section](#example)\n';
  assert.deepEqual(checkMarkdown(root, path, text), []);
});

test('missing local documentation target fails', (t) => {
  const { root, path } = fixture(t);
  assert.match(checkMarkdown(root, path, '[Missing](absent.md)\n').join('\n'),
    /missing local link/);
});

test('encoded traversal cannot escape the repository', (t) => {
  const { root, path } = fixture(t);
  assert.match(checkMarkdown(root, path, '[Outside](%2e%2e/%2e%2e/outside.md)\n').join('\n'),
    /escapes repository/);
});

test('symlink targets outside the repository fail', (t) => {
  const { root, path } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'miyo-catchup-scaffold-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'outside.md'), '# Synthetic outside fixture\n');
  symlinkSync(outside, join(root, 'docs', 'linked'));
  assert.match(checkMarkdown(root, path, '[Outside](linked/outside.md)\n').join('\n'),
    /resolves outside repository/);
});

test('malformed link encoding is reported rather than throwing', (t) => {
  const { root, path } = fixture(t);
  assert.match(checkMarkdown(root, path, '[Bad](%XX.md)\n').join('\n'),
    /invalid link encoding/);
});

test('fenced examples are not checked as documentation links', (t) => {
  const { root, path } = fixture(t);
  assert.deepEqual(checkMarkdown(root, path, '```md\n[Example](missing.md)\n```\n'), []);
});

test('unclosed fences and missing final newline fail', (t) => {
  const { root, path } = fixture(t);
  const errors = checkMarkdown(root, path, '```text\nunfinished');
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /unclosed code fence/);
  assert.match(errors.join('\n'), /missing final newline/);
});

test('an incomplete scaffold returns required-file diagnostics', (t) => {
  const { root } = fixture(t);
  const errors = checkRepository(root);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((error) => error.startsWith('Missing regular repository file:')));
});

test('saved tool truncation is rejected even when requirement IDs remain intact', (t) => {
  const { root, path } = fixture(t);
  for (const text of ['Warning: truncated output (original token count: 100)\n',
    'Total output lines: 753\n', 'start…1895 tokens truncated…end\n']) {
    assert.match(checkMarkdown(root, path, text).join('\n'), /tool truncation marker/);
  }
});
