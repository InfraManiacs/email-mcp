/**
 * Temp files for attachment tests. Deterministic sizes so size-report and cap
 * assertions can match exact byte counts; a single root dir per suite is
 * removed in afterAll.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class TmpFiles {
  private root = mkdtempSync(join(tmpdir(), 'email-att-'));

  /** Write `bytes` of filler and return the absolute path. */
  file(name: string, bytes: number): string {
    const p = join(this.root, name);
    writeFileSync(p, Buffer.alloc(bytes, 0x61));
    return p;
  }

  /** A path under the root that was never created. */
  missing(name: string): string {
    return join(this.root, name);
  }

  dir(): string {
    return this.root;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
