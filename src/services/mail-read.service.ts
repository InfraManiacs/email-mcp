/**
 * Read-model facade in front of ImapService.
 *
 * Every read tool goes through this service; writes stay on ImapService and
 * SmtpService. Today it is a pure pass-through. Upcoming phases route these
 * reads through the local mirror (CacheStore) with STATUS-validated freshness
 * and a live fallback, which is why the seam exists: tools depend on one
 * surface while the read strategy changes behind it.
 *
 * Parameter and return types are derived from ImapService so the two can
 * never drift while both paths exist.
 */

import type ImapService from './imap.service.js';

export default class MailReadService {
  constructor(private readonly imapService: ImapService) {}

  listEmails(
    account: string,
    options?: Parameters<ImapService['listEmails']>[1],
  ): ReturnType<ImapService['listEmails']> {
    return this.imapService.listEmails(account, options);
  }

  getEmail(
    account: string,
    emailId: string,
    mailbox?: string,
  ): ReturnType<ImapService['getEmail']> {
    return this.imapService.getEmail(account, emailId, mailbox);
  }

  getEmailFlags(
    account: string,
    emailId: string,
    mailbox?: string,
  ): ReturnType<ImapService['getEmailFlags']> {
    return this.imapService.getEmailFlags(account, emailId, mailbox);
  }

  searchEmails(
    account: string,
    query: string,
    options?: Parameters<ImapService['searchEmails']>[2],
  ): ReturnType<ImapService['searchEmails']> {
    return this.imapService.searchEmails(account, query, options);
  }

  getThread(
    account: string,
    messageId: string,
    mailbox?: string,
  ): ReturnType<ImapService['getThread']> {
    return this.imapService.getThread(account, messageId, mailbox);
  }

  findEmailFolder(
    account: string,
    emailId: string,
    sourceMailbox: string,
  ): ReturnType<ImapService['findEmailFolder']> {
    return this.imapService.findEmailFolder(account, emailId, sourceMailbox);
  }

  downloadAttachment(
    account: string,
    emailId: string,
    mailbox: string,
    filename: string,
    maxSizeBytes?: number,
  ): ReturnType<ImapService['downloadAttachment']> {
    return this.imapService.downloadAttachment(account, emailId, mailbox, filename, maxSizeBytes);
  }
}
