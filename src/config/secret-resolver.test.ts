import { resolveSecret, type SecretRunner } from './secret-resolver.js';

/** A fake `security`/`secret-tool` runner driven by a lookup table. */
function fakeRunner(
  table: Record<string, string>,
  opts: { fail?: Set<string> } = {},
): SecretRunner {
  return async (cmd, args) => {
    // Two argument shapes, one per backend. Reading only the macOS one made
    // every lookup on Linux resolve to '' — which is why these tests passed
    // on a developer's Mac and failed in CI.
    const service =
      cmd === 'secret-tool' ? args[args.indexOf('service') + 1] : args[args.indexOf('-s') + 1];
    const account =
      cmd === 'secret-tool' ? args[args.indexOf('account') + 1] : args[args.indexOf('-a') + 1];
    const key = `${service}/${account}`;
    if (opts.fail?.has(key)) {
      throw new Error(
        `SecKeychainSearchCopyNext: The specified item could not be found in the keychain.`,
      );
    }
    return table[key] ?? '';
  };
}

describe('resolveSecret', () => {
  it('returns a plain value unchanged (backward compatible)', async () => {
    const out = await resolveSecret('literal-app-password', { runner: fakeRunner({}) });
    expect(out).toBe('literal-app-password');
  });

  it('resolves keychain:<account> against the default email-mcp service', async () => {
    const runner = fakeRunner({ 'email-mcp/pandia': 'from-keychain' });
    const out = await resolveSecret('keychain:pandia', { runner, platform: 'darwin' });
    expect(out).toBe('from-keychain');
  });

  it('resolves keychain:<service>/<account> with an explicit service', async () => {
    const runner = fakeRunner({ 'proton/work': 'svc-scoped' });
    const out = await resolveSecret('keychain:proton/work', { runner, platform: 'darwin' });
    expect(out).toBe('svc-scoped');
  });

  it('trims a trailing newline from the keychain value', async () => {
    const runner = fakeRunner({ 'email-mcp/a': 'secret-with-nl\n' });
    expect(await resolveSecret('keychain:a', { runner, platform: 'darwin' })).toBe(
      'secret-with-nl',
    );
  });

  it('throws a clear, account-named error when the item is missing', async () => {
    const runner = fakeRunner({}, { fail: new Set(['email-mcp/ghost']) });
    const opts = { runner, platform: 'darwin' as const };
    await expect(resolveSecret('keychain:ghost', opts)).rejects.toThrow(/ghost/);
    await expect(resolveSecret('keychain:ghost', opts)).rejects.toThrow(/keychain/i);
  });

  // The Linux backend had no coverage at all, which is how the macOS-only
  // assumption in the fake went unnoticed.
  it('resolves through secret-tool on linux', async () => {
    const runner = fakeRunner({ 'email-mcp/pandia': 'from-libsecret' });
    const out = await resolveSecret('keychain:pandia', { runner, platform: 'linux' });
    expect(out).toBe('from-libsecret');
  });

  it('rejects an empty keychain reference', async () => {
    await expect(
      resolveSecret('keychain:', { runner: fakeRunner({}), platform: 'darwin' }),
    ).rejects.toThrow(/account/i);
  });

  it('resolves env:<VAR> from the environment', async () => {
    const out = await resolveSecret('env:MY_TEST_SECRET', {
      runner: fakeRunner({}),
      env: { MY_TEST_SECRET: 'from-env' },
    });
    expect(out).toBe('from-env');
  });

  it('throws when env:<VAR> is unset', async () => {
    await expect(resolveSecret('env:NOPE', { runner: fakeRunner({}), env: {} })).rejects.toThrow(
      /NOPE/,
    );
  });

  it('never passes the secret value as a command argument (store is separate)', async () => {
    // The read path's args carry only service/account identifiers — assert the
    // runner is called with no occurrence of the resolved secret.
    const seen: string[][] = [];
    const runner: SecretRunner = async (_cmd, args) => {
      seen.push(args);
      return 'top-secret';
    };
    await resolveSecret('keychain:pandia', { runner, platform: 'darwin' });
    expect(seen.flat()).not.toContain('top-secret');
  });
});

describe('resolveSecret cross-platform keychain dispatch', () => {
  it('uses the macOS `security` command on darwin', async () => {
    let seen: { cmd: string; args: string[] } | undefined;
    const runner: SecretRunner = async (cmd, args) => {
      seen = { cmd, args };
      return 'mac-secret';
    };
    const out = await resolveSecret('keychain:acct', { runner, platform: 'darwin' });
    expect(out).toBe('mac-secret');
    expect(seen?.cmd).toBe('security');
    expect(seen?.args).toEqual(['find-generic-password', '-s', 'email-mcp', '-a', 'acct', '-w']);
  });

  it('uses `secret-tool` (libsecret) on linux', async () => {
    let seen: { cmd: string; args: string[] } | undefined;
    const runner: SecretRunner = async (cmd, args) => {
      seen = { cmd, args };
      return 'linux-secret\n';
    };
    const out = await resolveSecret('keychain:myservice/acct', { runner, platform: 'linux' });
    expect(out).toBe('linux-secret');
    expect(seen?.cmd).toBe('secret-tool');
    expect(seen?.args).toEqual(['lookup', 'service', 'myservice', 'account', 'acct']);
  });

  it('refuses a keychain ref on an unsupported platform, pointing at env:', async () => {
    await expect(resolveSecret('keychain:acct', { platform: 'win32' })).rejects.toThrow(/env:/);
  });
});
