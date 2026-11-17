import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDisposableRetentionTarget, confinedArchivePath } from "./retention-boundary.js";

describe('retention administrative boundary', () => {
  it('allows explicit local test targets only', () => {
    expect(assertDisposableRetentionTarget('postgresql://odin:odin@127.0.0.1:55432/odin_test_storage')).toContain('odin_test_storage');
    for (const raw of [undefined, 'invalid', 'postgresql://x:y@remote/odin_test', 'postgresql://x:y@localhost/production', 'postgresql://x:y@localhost/production?name=odin_test', 'postgresql://x:y@localhost/odin_test?host=remote']) {
      expect(() => assertDisposableRetentionTarget(raw)).toThrow();
    }
  });
  it('refuses traversal and platform path aliases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurum-boundary-'));
    try {
      for (const name of ['../escape', '..\\escape', '/absolute', 'C:\\outside', 'file:stream', '.', '..', 'file. ', 'manifest.json.', 'CON', 'nul.json']) expect(() => confinedArchivePath(dir, name)).toThrow();
      writeFileSync(join(dir, 'valid.json'), '{}');
      expect(confinedArchivePath(dir, 'valid.json')).toBe(join(dir, 'valid.json'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses linked archive directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurum-links-'));
    const linked = `${dir}-link`;
    try {
      symlinkSync(dir, linked, 'junction');
      expect(() => confinedArchivePath(linked, 'manifest.json')).toThrow('ARCHIVE_LINK_REFUSED');
    } finally { rmSync(linked, { force: true }); rmSync(dir, { recursive: true, force: true }); }
  });
});
