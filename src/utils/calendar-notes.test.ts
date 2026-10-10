import { appendEmailLink, buildCalendarNotes, buildReminderNotes } from './calendar-notes.js';

describe('buildCalendarNotes', () => {
  it('includes email origin info', () => {
    const result = buildCalendarNotes({
      emailFrom: 'alice@example.com',
      emailSubject: 'Team Sync',
      emailDate: '2024-01-15',
    });
    expect(result).toContain('From: alice@example.com');
    expect(result).toContain('Subject: Team Sync');
    expect(result).toContain('Received: 2024-01-15');
  });

  it('includes organizer and attendees', () => {
    const result = buildCalendarNotes({
      organizer: 'alice@example.com',
      attendees: ['bob@example.com', 'charlie@example.com'],
    });
    expect(result).toContain('Organizer: alice@example.com');
    expect(result).toContain('Attendees: bob@example.com, charlie@example.com');
  });

  it('includes meeting URL with label', () => {
    const result = buildCalendarNotes({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      meetingUrlLabel: 'Google Meet',
    });
    expect(result).toContain('Google Meet: https://meet.google.com/abc-defg-hij');
  });

  it('includes dial-in, meeting ID, and passcode', () => {
    const result = buildCalendarNotes({
      dialIn: '+1 555 123 4567',
      meetingId: '123 456 789',
      passcode: '999888',
    });
    expect(result).toContain('Dial-in: +1 555 123 4567');
    expect(result).toContain('Meeting ID: 123 456 789');
    expect(result).toContain('Passcode: 999888');
  });

  it('truncates body excerpt to 500 chars with ellipsis', () => {
    const longBody = 'a'.repeat(600);
    const result = buildCalendarNotes({ bodyExcerpt: longBody });
    expect(result).toContain('a'.repeat(500));
    expect(result).toContain('…');
  });

  it('strips HTML from body excerpt', () => {
    const result = buildCalendarNotes({
      bodyExcerpt: '<p>Hello <b>world</b></p>',
    });
    expect(result).toContain('Hello world');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<b>');
  });

  it('formats attachment sizes correctly', () => {
    const result = buildCalendarNotes({
      savedAttachments: [
        { filename: 'small.txt', fileUrl: 'file:///tmp/small.txt', size: 500 },
        { filename: 'medium.pdf', fileUrl: 'file:///tmp/medium.pdf', size: 2048 },
        { filename: 'large.zip', fileUrl: 'file:///tmp/large.zip', size: 5 * 1024 * 1024 },
      ],
    });
    expect(result).toContain('500 B');
    expect(result).toContain('2 KB');
    expect(result).toContain('5.0 MB');
  });

  it('returns empty string for empty input', () => {
    expect(buildCalendarNotes({})).toBe('');
  });

  it('includes an open-email deep link in the origin section when emailUrl is given', () => {
    const result = buildCalendarNotes({
      emailFrom: 'alice@example.com',
      emailUrl: 'message://%3Cabc@host%3E',
    });
    expect(result).toContain('🔗 Open email: message://%3Cabc@host%3E');
  });

  it('omits the open-email line when emailUrl is absent', () => {
    const result = buildCalendarNotes({ emailFrom: 'alice@example.com' });
    expect(result).not.toContain('Open email');
  });
});

describe('appendEmailLink', () => {
  it('appends the link after a blank line', () => {
    expect(appendEmailLink('Some notes', 'message://%3Cabc@host%3E')).toBe(
      'Some notes\n\n🔗 Open email: message://%3Cabc@host%3E',
    );
  });

  it('returns the notes unchanged when there is no URL', () => {
    expect(appendEmailLink('Some notes', undefined)).toBe('Some notes');
  });

  it('returns just the link line for empty notes', () => {
    expect(appendEmailLink('', 'message://%3Cabc@host%3E')).toBe(
      '🔗 Open email: message://%3Cabc@host%3E',
    );
  });

  it('does not stack blank lines when the notes already end with whitespace', () => {
    expect(appendEmailLink('Some notes\n\n', 'message://%3Cabc@host%3E')).toBe(
      'Some notes\n\n🔗 Open email: message://%3Cabc@host%3E',
    );
  });
});

describe('buildReminderNotes', () => {
  it('builds from, subject, excerpt, and the open-email link', () => {
    const result = buildReminderNotes({
      emailFrom: 'Alice <alice@example.com>',
      emailSubject: 'Invoice due',
      bodyExcerpt: 'Please pay by Friday.',
      emailUrl: 'message://%3Cabc@host%3E',
    });
    expect(result).toBe(
      '📧 From: Alice <alice@example.com>\n' +
        '📌 Subject: Invoice due\n\n' +
        'Please pay by Friday.\n\n' +
        '🔗 Open email: message://%3Cabc@host%3E',
    );
  });

  it('omits the link line when no emailUrl is given', () => {
    const result = buildReminderNotes({
      emailFrom: 'alice@example.com',
      emailSubject: 'Invoice due',
      bodyExcerpt: 'Please pay by Friday.',
    });
    expect(result).not.toContain('Open email');
    expect(result).toContain('📧 From: alice@example.com');
  });

  it('skips empty fields without leaving blank lines', () => {
    const result = buildReminderNotes({ emailSubject: 'Invoice due' });
    expect(result).toBe('📌 Subject: Invoice due');
  });
});
