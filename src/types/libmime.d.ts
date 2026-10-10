/**
 * Minimal ambient types for libmime (ships none of its own).
 *
 * Already in the dependency tree as imapflow's MIME codec; declared directly
 * for RFC 2047 header decoding. Only the functions actually used are typed.
 */
declare module 'libmime' {
  interface Libmime {
    /** Decode RFC 2047 encoded words ("=?UTF-8?B?...?=") in a header value. */
    decodeWords(value: string): string;
    /** Encode a header value's non-ASCII runs as RFC 2047 words. */
    encodeWords(value: string, mimeWordEncoding?: string, maxLength?: number): string;
  }
  const libmime: Libmime;
  export = libmime;
}
