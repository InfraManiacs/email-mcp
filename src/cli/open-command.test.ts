import { resolveOpenPlan } from './open-command.js';

describe('resolveOpenPlan', () => {
  const url = 'message://%3Cabc@host%3E';

  it('launches Mail on macOS by default', () => {
    expect(resolveOpenPlan({ url, print: false, platform: 'darwin' })).toEqual({
      action: 'launch',
      url,
    });
  });

  it('prints instead of launching when --print is given', () => {
    expect(resolveOpenPlan({ url, print: true, platform: 'darwin' })).toEqual({
      action: 'print',
      url,
    });
  });

  it('falls back to printing on platforms without a message: handler', () => {
    const plan = resolveOpenPlan({ url, print: false, platform: 'linux' });
    expect(plan.action).toBe('print');
    expect(plan.url).toBe(url);
    expect(plan.reason).toMatch(/macOS/);
  });

  it('falls back to printing on Windows', () => {
    expect(resolveOpenPlan({ url, print: false, platform: 'win32' }).action).toBe('print');
  });
});
