/** Input validation and sanitization utilities. */

/** Comfortably inside the 255-byte name limit common to ext4, APFS and NTFS. */
const MAX_ATTACHMENT_NAME_CHARS = 200;

/**
 * Reduce a sender-supplied attachment name to one that is safe to write.
 *
 * The name arrives in the message's Content-Disposition header, so anyone who
 * can email the user chooses it. Passed to `path.join` as-is, a name like
 * `../../../../.zshrc` escapes the destination directory entirely and
 * overwrites whatever sits there — and since the CLI defaults its destination
 * to the working directory, even a plain leading dot is enough to drop a file
 * that shell startup will read.
 *
 * The result is always a bare filename: no directory part, no control
 * characters, no leading dot, and never empty.
 */
export function safeAttachmentFilename(name: string): string {
  // Split on both separators whatever the platform: POSIX `basename` leaves
  // `..\..\x` untouched, and that name traverses once it reaches Windows.
  const lastSegment = name.split(/[/\\]/).pop() ?? '';

  const cleaned = lastSegment
    /* eslint-disable no-control-regex */
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\x00-\x1F\x7F]/g, '')
    /* eslint-enable no-control-regex */
    // Windows discards these silently, so a name differing only by them would
    // be two files here and one there.
    .replace(/[. ]+$/, '')
    // A leading dot hides the file and lets an attachment pose as a dotfile.
    .replace(/^\.+/, '')
    .trim();

  if (cleaned.length === 0) return 'attachment';
  return cleaned.slice(0, MAX_ATTACHMENT_NAME_CHARS);
}

/**
 * Validate and sanitize an IMAP mailbox name.
 * Rejects names containing IMAP wildcard characters (`*`, `%`) or empty strings.
 * @param name - The mailbox name to validate.
 * @returns The trimmed mailbox name.
 */
export function sanitizeMailboxName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Mailbox name must not be empty');
  }
  if (trimmed.includes('*') || trimmed.includes('%')) {
    throw new Error('Mailbox name must not contain IMAP wildcard characters (* or %)');
  }
  return trimmed;
}

/**
 * Strip control characters from an IMAP search query.
 * Removes ASCII 0-31 except tab (0x09) and newline (0x0A).
 * @param query - The raw search query.
 * @returns The sanitized query string.
 */
export function sanitizeSearchQuery(query: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize control chars from user input
  const cleaned = query.replace(/[\x00-\x08\x0B-\x1F]/g, '').trim(); // eslint-disable-line no-control-regex
  if (cleaned.length === 0) {
    throw new Error('Search query must not be empty after sanitization');
  }
  return cleaned;
}

/**
 * Validate a webhook URL.
 * Ensures the URL uses http(s) and does not point to a private or loopback address.
 * @param url - The webhook URL to validate.
 */
export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https protocol, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // new URL('https://[::1]') stores hostname as '[::1]'
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '::1' || bare === '0.0.0.0') {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }

  const reject = (): never => {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  };

  const isPrivateIpv4 = (a: number, b: number): boolean =>
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // 169.254.0.0/16: link-local, including the cloud metadata address
    // (169.254.169.254) that hands out IAM credentials on AWS/GCP/Azure.
    a === 169 ||
    // 100.64.0.0/10: shared address space for carrier-grade NAT.
    (a === 100 && b >= 64 && b <= 127);

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4Match) {
    const [, a = 0, b = 0] = ipv4Match.map(Number);
    if (isPrivateIpv4(a, b)) reject();
    return;
  }

  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) carries the same address in
  // a form the IPv4 regex above never sees. The WHATWG URL parser (and so
  // `new URL(...).hostname`) normalizes the embedded IPv4 part to two hex
  // groups (e.g. ::ffff:169.254.169.254 becomes ::ffff:a9fe:a9fe) rather
  // than keeping it dotted — handle both forms.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(bare);
  if (mappedHex) {
    const word1 = parseInt(mappedHex[1] ?? '0', 16);
    if (isPrivateIpv4(word1 >> 8, word1 & 0xff)) reject();
    return;
  }
  const mappedDotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (mappedDotted) {
    const [, a = 0, b = 0] = mappedDotted.map(Number);
    if (isPrivateIpv4(a, b)) reject();
    return;
  }

  // fe80::/10 (link-local) and fc00::/7 (unique-local, fc00:: or fd00::).
  if (/^fe[89ab][0-9a-f]:/.test(bare) || /^f[cd][0-9a-f]{2}:/.test(bare)) {
    reject();
  }
}

/**
 * Sanitize a value for use in a template.
 * When `html` is true, HTML-special characters are escaped.
 * @param value - The template variable value.
 * @param html - Whether to apply HTML escaping.
 * @returns The sanitized value.
 */
export function sanitizeTemplateVariable(value: string, html: boolean): string {
  if (!html) {
    return value;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate an email label name.
 * Rejects labels with control characters or that exceed 200 characters.
 * @param name - The label name to validate.
 * @returns The trimmed label name.
 */
export function validateLabelName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Label name must not be empty');
  }
  if (trimmed.length > 200) {
    throw new Error('Label name must not exceed 200 characters');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in label names
  if (/[\x00-\x1F]/.test(trimmed)) {
    throw new Error('Label name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  return trimmed;
}

/**
 * Validate that an input string does not exceed a maximum length.
 * @param input - The input string to check.
 * @param maxLength - The maximum allowed length.
 * @param fieldName - The field name for the error message.
 */
export function validateInputLength(input: string, maxLength: number, fieldName: string): void {
  if (input.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
}
