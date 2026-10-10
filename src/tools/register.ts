/**
 * Tool registration — single wiring point.
 *
 * Registers all MCP tools with the server instance.
 * In read-only mode, write tools are not registered at all.
 *
 * Read tools that fetch mail content take the MailReadService facade; write
 * tools (and reads that are deliberately live, like health checks) take
 * ImapService directly.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { AppServices } from '../app.js';
import { resolveSendLimitMb } from '../config/send-limit.js';
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

export default function registerAllTools(server: McpServer, services: AppServices): void {
  const {
    config,
    connections,
    imapService,
    mailReadService,
    smtpService,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
    clipboardService,
    verificationCatcher,
  } = services;
  const { readOnly } = config.settings;

  // Read tools — always registered
  registerAccountsTools(server, connections);
  registerMailboxesTools(server, imapService);
  registerEmailsTools(server, mailReadService, imapService);
  registerAttachmentTools(server, mailReadService);
  registerContactsTools(server, imapService);
  registerThreadTools(server, mailReadService);
  registerTemplateReadTools(server, templateService);
  registerCalendarTools(
    server,
    imapService,
    calendarService,
    localCalendarService,
    remindersService,
    { autoDownloadAttachments: config.settings.attachments.autoDownload },
  );
  registerAnalyticsTools(server, imapService);
  registerHealthTools(server, connections, imapService);
  registerLocateTools(server, mailReadService);
  registerWatcherTools(server, watcherService, hooksService);
  // Clipboard copy is a local convenience, not a mailbox write — registered
  // in read-only mode too (same reasoning as test_notification).
  registerVerificationTools(
    server,
    imapService,
    config,
    watcherService,
    clipboardService,
    verificationCatcher,
  );

  // Write tools — skipped in read-only mode
  if (!readOnly) {
    const globalMb = config.settings.send.maxAttachmentMb;
    registerSendTools(server, smtpService, {
      globalMb,
      forAccount: (name) => {
        const account = config.accounts.find((a) => a.name === name);
        return account ? resolveSendLimitMb(account, globalMb) : globalMb;
      },
    });
    registerManageTools(server, imapService);
    registerLabelTools(server, imapService);
    registerBulkTools(server, imapService);
    registerDraftTools(server, imapService, smtpService);
    registerFolderTools(server, imapService);
    registerTemplateWriteTools(server, templateService, imapService, smtpService);
    registerSchedulerTools(server, schedulerService);
  }
}
