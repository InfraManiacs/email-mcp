import { EMAIL_USAGE, emailUsage } from './email-help.js';

describe('emailUsage', () => {
  it('has a usage entry for every email command', () => {
    for (const cmd of [
      'list',
      'read',
      'search',
      'mailboxes',
      'flag',
      'delete',
      'attach',
      'reply',
      'send',
    ]) {
      expect(EMAIL_USAGE[cmd], `usage for ${cmd}`).toBeTruthy();
    }
  });

  it('returns a per-command usage string naming the command and its key flags', () => {
    expect(emailUsage('list')).toMatch(/email-mcp list/);
    expect(emailUsage('list')).toMatch(/--unread/);
    expect(emailUsage('send')).toMatch(/--to/);
    expect(emailUsage('send')).toMatch(/--subject/);
    expect(emailUsage('attach')).toMatch(/<id>/);
  });

  it('returns an overview listing all commands when none is given', () => {
    const all = emailUsage();
    for (const cmd of ['list', 'read', 'search', 'send', 'reply']) {
      expect(all).toContain(cmd);
    }
  });

  it('documents --json and --account as shared options in the overview', () => {
    const all = emailUsage();
    expect(all).toMatch(/--json/);
    expect(all).toMatch(/--account/);
  });
});
