/**
 * MCP callers routinely send every parameter as a string. A bare `z.number()`
 * rejects "20", which breaks the tool for those clients before the handler
 * ever runs — the failure is silent from the caller's point of view.
 *
 * This walks the real `inputSchema` every registrar in `register.ts` hands
 * to `server.registerTool`, and asserts the property that prevents it: a
 * field that accepts the number 5 must also accept the string "5". It walks
 * every registrar actually wired into the server (the same set `register.ts`
 * calls) rather than a hand-picked subset, so a tool added later is covered
 * automatically instead of silently falling outside the check.
 */

import type { ZodTypeAny } from 'zod';
import registerAccountsTools from './accounts.tool.js';
import registerAnalyticsTools from './analytics.tool.js';
import registerAttachmentTools from './attachments.tool.js';
import registerBulkTools from './bulk.tool.js';
import registerCalendarTools from './calendar.tool.js';
import registerContactsTools from './contacts.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerFolderTools from './folders.tool.js';
import registerHealthTools from './health.tool.js';
import registerLabelTools from './label.tool.js';
import registerLocateTools from './locate.tool.js';
import registerMailboxesTools from './mailboxes.tool.js';
import registerManageTools from './manage.tool.js';
import registerSchedulerTools from './scheduler.tool.js';
import registerSendTools from './send.tool.js';
import { registerTemplateReadTools, registerTemplateWriteTools } from './templates.tool.js';
import registerThreadTools from './thread.tool.js';
import registerVerificationTools from './verification.tool.js';
import registerWatcherTools from './watcher.tool.js';

type Shape = Record<string, ZodTypeAny>;

/** Captures the inputSchema shape each tool registers, without a real server. */
function collectSchemas(register: (...args: never[]) => void, args: unknown[]): Map<string, Shape> {
  const schemas = new Map<string, Shape>();
  const server = {
    registerTool: (name: string, config: { inputSchema?: { shape: Shape } }) => {
      if (config.inputSchema) schemas.set(name, config.inputSchema.shape);
    },
  };
  register(...([server, ...args] as never[]));
  return schemas;
}

/** A fake service object: every property is itself callable and chainable. */
function fakeService(): never {
  const target = () => fakeService();
  return new Proxy(target, { get: () => fakeService() }) as never;
}

const fakes = (n: number): unknown[] => Array.from({ length: n }, () => fakeService());

// registerSendTools' last argument is interpolated into a description string
// (`${sendLimit.globalMb} MB`), which a generic proxy fake can't satisfy —
// String(proxy) never bottoms out in a primitive. Give it the real shape.
const sendLimitFake = { globalMb: 25, forAccount: () => 25 };

// registerAttachmentTools' last argument is interpolated/`.join()`ed into a
// description string too — same reasoning as sendLimitFake above.
const attachmentDownloadConfigFake = {
  dir: '/tmp/downloads',
  allowedExtensions: ['pdf'],
  maxBytes: 25 * 1024 * 1024,
};

/** (registrar, positional service args) for every registrar `register.ts` calls. */
const REGISTRATIONS: [register: (...args: never[]) => void, args: unknown[]][] = [
  [registerAccountsTools as never, fakes(1)],
  [registerMailboxesTools as never, fakes(1)],
  [registerEmailsTools as never, fakes(2)],
  [registerAttachmentTools as never, [fakeService(), fakeService(), attachmentDownloadConfigFake]],
  [registerContactsTools as never, fakes(1)],
  [registerThreadTools as never, fakes(1)],
  [registerTemplateReadTools as never, fakes(1)],
  [registerCalendarTools as never, fakes(5)],
  [registerAnalyticsTools as never, fakes(1)],
  [registerHealthTools as never, fakes(5)],
  [registerLocateTools as never, fakes(1)],
  [registerWatcherTools as never, fakes(2)],
  [registerVerificationTools as never, fakes(5)],
  [registerSendTools as never, [fakeService(), sendLimitFake]],
  [registerManageTools as never, fakes(1)],
  [registerLabelTools as never, fakes(1)],
  [registerBulkTools as never, fakes(1)],
  [registerDraftTools as never, fakes(2)],
  [registerFolderTools as never, fakes(1)],
  [registerTemplateWriteTools as never, fakes(3)],
  [registerSchedulerTools as never, fakes(1)],
];

/** Every (tool, field) pair across every registered tool. */
function everyField(): { tool: string; field: string; schema: ZodTypeAny }[] {
  return REGISTRATIONS.flatMap(([register, args]) => {
    const schemas = collectSchemas(register, args);
    return [...schemas.entries()].flatMap(([tool, shape]) =>
      Object.entries(shape).map(([field, schema]) => ({ tool, field, schema })),
    );
  });
}

describe('numeric tool parameters accept strings', () => {
  it('finds tools to check, so a broken harness cannot pass vacuously', () => {
    const fields = everyField();

    expect(fields.length).toBeGreaterThan(50);
    expect(new Set(fields.map((f) => f.tool)).size).toBeGreaterThan(20);
  });

  it('accepts a numeric string wherever it accepts a number, scalar or array', () => {
    // Probe behaviourally rather than inspecting the Zod type: a field is
    // "scalar numeric" if it accepts the number 5, "array numeric" if it
    // accepts [5] but not 5 itself (ids: z.array(z.number())). Anything else
    // is out of scope for this check, including fields already permissive
    // enough to accept both forms.
    const offenders = everyField()
      .map(({ tool, field, schema }) => {
        if (schema.safeParse(5).success) {
          return schema.safeParse('5').success ? null : `${tool}.${field}`;
        }
        if (schema.safeParse([5]).success) {
          return schema.safeParse(['5']).success ? null : `${tool}.${field}`;
        }
        return null;
      })
      .filter((offender): offender is string => offender !== null);

    expect(offenders).toEqual([]);
  });
});
