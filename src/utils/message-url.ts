/**
 * Build Apple Mail `message:` deep-link URLs from RFC 5322 Message-IDs.
 *
 * Mail.app resolves `message://%3C<message-id>%3E` to the matching message in
 * any configured account, independent of which mailbox it currently lives in.
 * The angle brackets are required and must be percent-encoded; the ID itself
 * only needs encoding for characters that would break URL parsing.
 */

/**
 * Convert a Message-ID (with or without surrounding angle brackets) into a
 * `message://` URL, or `undefined` when no usable ID is present.
 */
export function buildMessageUrl(messageId: string | undefined): string | undefined {
  const bare = (messageId ?? '').trim().replace(/^</, '').replace(/>$/, '').trim();
  if (!bare) return undefined;
  // encodeURI covers spaces, percent signs, and non-ASCII, but deliberately
  // leaves `#` and `?` alone — those would start a fragment/query, so encode
  // them explicitly.
  const encoded = encodeURI(bare).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `message://%3C${encoded}%3E`;
}
