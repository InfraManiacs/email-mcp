// `import 'vitest'` makes this file a module, so the block below is module
// AUGMENTATION (interface merging) rather than a replacement declaration that
// would shadow vitest's real exports (inject, etc.) project-wide.
import 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    greenmailHost: string;
    greenmailSmtpPort: number;
    greenmailSmtpsPort: number;
    greenmailImapPort: number;
    greenmailImapsPort: number;
  }
}
