import eventBus from '../services/event-bus.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

const { instances, mockState } = vi.hoisted(() => ({
  instances: [] as { usable: boolean }[],
  // What the fake server "negotiated": toggled per test to simulate a
  // connection that did or did not end up encrypted.
  mockState: { secureConnection: true },
}));

vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;
    secureConnection = mockState.secureConnection;
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    close = vi.fn();

    constructor() {
      instances.push(this);
    }
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const account: AccountConfig = {
  name: 'work',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'secret',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('ConnectionManager', () => {
  beforeEach(() => {
    instances.length = 0;
    vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses a usable IMAP client without announcing a reconnect', async () => {
    const manager = new ConnectionManager([account]);

    const first = await manager.getImapClient('work');
    const second = await manager.getImapClient('work');

    expect(second).toBe(first);
    expect(instances).toHaveLength(1);
    expect(eventBus.emit).not.toHaveBeenCalledWith('imap:reconnect', expect.anything());
  });

  it('announces a reconnect when it replaces a dead connection', async () => {
    const manager = new ConnectionManager([account]);

    const first = await manager.getImapClient('work');
    // Simulate the socket dying between tool calls.
    (first as unknown as { usable: boolean }).usable = false;

    const second = await manager.getImapClient('work');

    expect(second).not.toBe(first);
    // Anything derived from the old connection — capability probes, cached
    // UIDVALIDITY, label-strategy memos — is now suspect and must be told.
    expect(eventBus.emit).toHaveBeenCalledWith('imap:reconnect', { account: 'work' });
  });
});

describe('IMAP STARTTLS enforcement', () => {
  const starttlsAccount: AccountConfig = {
    ...account,
    name: 'starttls',
    imap: { host: 'imap.example.com', port: 143, tls: false, starttls: true, verifySsl: true },
  };

  beforeEach(() => {
    instances.length = 0;
  });
  afterEach(() => {
    mockState.secureConnection = true;
  });

  it('rejects the connection when starttls is required but the session stayed plaintext', async () => {
    mockState.secureConnection = false;
    const manager = new ConnectionManager([starttlsAccount]);

    await expect(manager.getImapClient('starttls')).rejects.toThrow(/STARTTLS/);
  });

  it('accepts the connection when the session was upgraded', async () => {
    mockState.secureConnection = true;
    const manager = new ConnectionManager([starttlsAccount]);

    await expect(manager.getImapClient('starttls')).resolves.toBeDefined();
  });

  it('does not demand upgrade when starttls is off', async () => {
    mockState.secureConnection = false;
    const manager = new ConnectionManager([
      account,
      { ...account, name: 'plainok', imap: { ...account.imap, tls: false, starttls: false } },
    ]);

    await expect(manager.getImapClient('plainok')).resolves.toBeDefined();
  });
});
