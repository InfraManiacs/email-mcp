/**
 * Persistent store for hub-connected accounts.
 *
 * One JSON document, encrypted with AES-256-GCM, written atomically
 * (temp file + rename) with owner-only permissions. Refresh tokens never
 * touch disk in plaintext — the state volume may well be NFS.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { type Sealed, seal, unseal } from './crypto.js';

export interface HubAccountRecord {
  name: string;
  email: string;
  provider: 'google';
  refreshToken: string;
  connectedAt: string;
  connectedBy: string;
}

interface StoreDocument {
  accounts: HubAccountRecord[];
}

export default class HubAccountStore {
  private records: HubAccountRecord[] = [];

  constructor(
    private readonly filePath: string,
    private readonly key: Buffer,
  ) {}

  /** Load from disk. A missing file is an empty store; a bad key throws. */
  async load(): Promise<HubAccountRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = [];
        return [];
      }
      throw err;
    }
    let doc: StoreDocument;
    try {
      doc = JSON.parse(unseal(this.key, JSON.parse(raw) as Sealed)) as StoreDocument;
    } catch (err) {
      throw new Error(
        `Could not decrypt hub account store at ${this.filePath} — was EMAIL_MCP_HUB_SECRET_KEY changed? ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    this.records = doc.accounts;
    return [...this.records];
  }

  list(): HubAccountRecord[] {
    return [...this.records];
  }

  get(name: string): HubAccountRecord | undefined {
    return this.records.find((r) => r.name === name);
  }

  async upsert(record: HubAccountRecord): Promise<void> {
    const next = this.records.filter((r) => r.name !== record.name);
    next.push(record);
    await this.persist(next);
  }

  async remove(name: string): Promise<HubAccountRecord | undefined> {
    const existing = this.get(name);
    if (!existing) return undefined;
    await this.persist(this.records.filter((r) => r.name !== name));
    return existing;
  }

  private async persist(records: HubAccountRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const sealed = seal(this.key, JSON.stringify({ accounts: records } satisfies StoreDocument));
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sealed), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.records = records;
  }
}
