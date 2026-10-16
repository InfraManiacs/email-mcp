/**
 * Resource registration — single wiring point.
 *
 * Registers all MCP resources with the server instance.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { AppServices } from '../app.js';
import registerAccountsResource from './accounts.resource.js';
import registerMailboxesResource from './mailboxes.resource.js';
import registerScheduledResource from './scheduled.resource.js';
import registerStatsResource from './stats.resource.js';
import registerTemplatesResource from './templates.resource.js';
import registerUnreadResource from './unread.resource.js';

export default function registerAllResources(server: McpServer, services: AppServices): void {
  const { connections, imapService, templateService, schedulerService } = services;

  registerAccountsResource(server, connections);
  registerMailboxesResource(server, connections, imapService);
  registerUnreadResource(server, connections, imapService);
  registerTemplatesResource(server, templateService);
  registerStatsResource(server, connections, imapService);
  registerScheduledResource(server, schedulerService);
}
