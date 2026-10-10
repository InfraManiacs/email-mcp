import { describe, expect, it } from 'vitest';

import { buildMessageUrl } from './message-url.js';

describe('buildMessageUrl', () => {
  it('wraps a bare Message-ID in percent-encoded angle brackets', () => {
    expect(buildMessageUrl('abc.123@mail.example.com')).toBe(
      'message://%3Cabc.123@mail.example.com%3E',
    );
  });

  it('strips angle brackets already present on the Message-ID', () => {
    expect(buildMessageUrl('<abc.123@mail.example.com>')).toBe(
      'message://%3Cabc.123@mail.example.com%3E',
    );
  });

  it('trims surrounding whitespace before building the URL', () => {
    expect(buildMessageUrl('  <abc@host>  ')).toBe('message://%3Cabc@host%3E');
  });

  it('returns undefined for an empty or missing Message-ID', () => {
    expect(buildMessageUrl('')).toBeUndefined();
    expect(buildMessageUrl('   ')).toBeUndefined();
    expect(buildMessageUrl('<>')).toBeUndefined();
    expect(buildMessageUrl(undefined)).toBeUndefined();
  });

  it('percent-encodes characters that would break URL parsing', () => {
    expect(buildMessageUrl('a b#c?d%e@host')).toBe('message://%3Ca%20b%23c%3Fd%25e@host%3E');
  });

  it('percent-encodes non-ASCII characters', () => {
    expect(buildMessageUrl('grüße@host')).toBe('message://%3Cgr%C3%BC%C3%9Fe@host%3E');
  });
});
