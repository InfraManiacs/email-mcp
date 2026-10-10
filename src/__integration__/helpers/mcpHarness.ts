/**
 * In-process MCP tool harness for integration tests.
 *
 * Registers the real tool handlers against a real McpServer and drives them
 * through an InMemoryTransport-linked Client — the same request path a live
 * client uses, minus the socket. This is what makes attachment tests true
 * end-to-end: zod input validation, the size-report formatting, and the
 * pre-send cap all run exactly as they do in production, rather than being
 * bypassed by calling the service layer directly.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import createServer from '../../server.js';
import type ImapService from '../../services/imap.service.js';
import type SmtpService from '../../services/smtp.service.js';
import registerAttachmentTools from '../../tools/attachments.tool.js';
import registerEmailsTools from '../../tools/emails.tool.js';
import registerSendTools from '../../tools/send.tool.js';

export interface McpToolResult {
  isError: boolean;
  text: string;
  structured: unknown;
}

export interface McpHarness {
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

/**
 * Spin up a client wired to a server exposing the send, attachment, and email
 * tool groups backed by the given services. `maxAttachmentMb` is the cap the
 * send/reply tools enforce — tests pass a small value to exercise rejection.
 */
export async function createMcpHarness(
  imapService: ImapService,
  smtpService: SmtpService,
  maxAttachmentMb: number,
): Promise<McpHarness> {
  const server = createServer();
  registerEmailsTools(server, imapService);
  registerAttachmentTools(server, imapService);
  registerSendTools(server, smtpService, maxAttachmentMb);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-tool-harness', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
        structuredContent?: unknown;
      };
      const text = (res.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return { isError: Boolean(res.isError), text, structured: res.structuredContent };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
