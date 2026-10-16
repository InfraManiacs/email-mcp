/**
 * XDG Base Directory path resolution.
 * Follows the XDG Base Directory Specification for cross-platform config paths.
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 */

import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'email-mcp';

export const xdg = {
  /** Config directory: ~/.config/email-mcp/ */
  config: path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), APP_NAME),

  /** Data directory: ~/.local/share/email-mcp/ */
  data: path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    APP_NAME,
  ),

  /** State directory: ~/.local/state/email-mcp/ */
  state: path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
    APP_NAME,
  ),

  /** Cache directory: ~/.cache/email-mcp/ */
  cache: path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), APP_NAME),
} as const;

/** Full path to the config file */
export const CONFIG_FILE = path.join(xdg.config, 'config.toml');

/** Directory for user-defined email templates */
export const TEMPLATES_DIR = path.join(xdg.config, 'templates');

/** Directory for scheduled email queue */
export const SCHEDULED_DIR = path.join(xdg.state, 'scheduled');

/** Directory for sent scheduled email records */
export const SCHEDULED_SENT_DIR = path.join(xdg.state, 'scheduled', 'sent');

/** Directory for attachments saved when adding email events to the local calendar */
export const CALENDAR_ATTACHMENTS_DIR = path.join(xdg.data, 'calendar-attachments');

/** JSON state file tracking which emails have been auto-processed for calendar/reminders */
export const CALENDAR_STATE_FILE = path.join(xdg.state, 'calendar-processed.json');

/** JSON state file tracking which emails the verification catcher already scanned */
export const VERIFICATION_STATE_FILE = path.join(xdg.state, 'verification-processed.json');

/** JSON state file holding the IDLE watcher's last-seen UID per account/folder */
export const WATCHER_STATE_FILE = path.join(xdg.state, 'watcher-watermarks.json');

/** JSON record of the detached HTTP server started by `email-mcp server start` */
export const DAEMON_STATE_FILE = path.join(xdg.state, 'daemon.json');

/** Combined stdout/stderr log of the detached HTTP server */
export const DAEMON_LOG_FILE = path.join(xdg.state, 'server.log');

/**
 * Local mirror of server-side mail (envelopes, flags, bodies, search index).
 *
 * Lives under the cache directory because it is entirely regenerable — every
 * row can be re-fetched from IMAP. Deleting it costs time, never data.
 */
export const CACHE_DB = path.join(xdg.cache, 'cache.db');

/**
 * Content-addressed attachment bytes, indexed by the `attachment` table in
 * {@link CACHE_DB}. Regenerable for the same reason the mirror is.
 */
export const CACHE_BLOBS_DIR = path.join(xdg.cache, 'blobs');
