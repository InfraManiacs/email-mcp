/**
 * Guards a property of the whole tool surface, not of any one tool:
 *
 *   No tool input schema may emit a regex containing a lookaround assertion.
 *
 * llama.cpp compiles the entire `tools` array into a single GBNF grammar for
 * constrained decoding, and GBNF has no lookahead/lookbehind. One offending
 * `pattern` anywhere aborts grammar compilation, so every tool in the request
 * fails — including tools belonging to other servers. OpenAI's tool-schema
 * validator rejects the same construct ("regex lookaround is not supported").
 *
 * This walks every registered tool's real inputSchema via `z.toJSONSchema`
 * (which normalizes optional/default/array wrapping into plain JSON Schema
 * `pattern` strings) rather than asserting on the handful of call sites that
 * happened to be wrong: the next `.email()`, `.url()`, or hand-written
 * `.regex()` must fail here too.
 */

import { z } from 'zod';
import type { AppServices } from '../app.js';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

/** Matches lookahead `(?=` `(?!` and lookbehind `(?<=` `(?<!`. */
const LOOKAROUND = /\((?:\?=|\?!|\?<=|\?<!)/;

/** A fake service: every property access and call returns another fake. */
function fakeService(): never {
  const target = () => fakeService();
  return new Proxy(target, { get: () => fakeService() }) as never;
}

function fakeConfig(): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly: false,
      send: { saveToSent: false, maxAttachmentMb: 25 },
      attachments: { autoDownload: false },
    },
    accounts: [],
  } as unknown as AppConfig;
}

interface CapturedTool {
  name: string;
  inputSchema: z.ZodType;
}

function captureRegisteredTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const server = {
    registerTool: (name: string, config: { inputSchema?: z.ZodType }) => {
      if (config.inputSchema) captured.push({ name, inputSchema: config.inputSchema });
    },
  };

  const services = {
    config: fakeConfig(),
    connections: fakeService(),
    imapService: fakeService(),
    mailReadService: fakeService(),
    smtpService: fakeService(),
    templateService: fakeService(),
    calendarService: fakeService(),
    localCalendarService: fakeService(),
    remindersService: fakeService(),
    schedulerService: fakeService(),
    watcherService: fakeService(),
    hooksService: fakeService(),
    clipboardService: fakeService(),
    dialogService: fakeService(),
    verificationCatcher: fakeService(),
  } as unknown as AppServices;

  registerAllTools(server as never, services);
  return captured;
}

/** Every `pattern` string anywhere in a JSON Schema tree, however deeply nested. */
function collectPatterns(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  const record = node as Record<string, unknown>;
  if (typeof record.pattern === 'string') found.push(record.pattern);
  for (const value of Object.values(record)) {
    collectPatterns(value, found);
  }
  return found;
}

describe('tool schemas are GBNF-compilable', () => {
  const tools = captureRegisteredTools();

  it('registers a meaningful number of tools (guards against a silent no-op)', () => {
    expect(tools.length).toBeGreaterThan(20);
  });

  it('emits no lookaround assertions in any tool input schema', () => {
    const offenders = tools.flatMap(({ name, inputSchema }) =>
      collectPatterns(z.toJSONSchema(inputSchema))
        .filter((pattern) => LOOKAROUND.test(pattern))
        .map((pattern) => `${name}: ${pattern}`),
    );

    expect(offenders).toEqual([]);
  });

  // Proves the check above isn't passing vacuously because the detector
  // itself is broken — a schema that genuinely contains a lookaround must
  // still be caught, independent of what the real tool surface happens to
  // contain today.
  it('would catch a lookaround if one were introduced', () => {
    const offending = z.object({ note: z.string().regex(/^(?=.*foo)bar$/) });
    const patterns = collectPatterns(z.toJSONSchema(offending));
    expect(patterns.some((p) => LOOKAROUND.test(p))).toBe(true);
  });
});
