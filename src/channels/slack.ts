import https from 'https';

import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks, with code-block
// awareness: if a split point falls inside a triple-backtick block the block
// is closed at the end of the chunk and reopened at the start of the next.
const MAX_MESSAGE_LENGTH = 4000;
const SPLIT_TARGET = 3900; // headroom for closing/reopening backticks

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n', SPLIT_TARGET);
    if (splitAt <= 0) splitAt = SPLIT_TARGET;
    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
    // odd number of ``` = split landed inside a code block → close & reopen
    if ((chunk.match(/```/g) ?? []).length % 2 !== 0) {
      chunk += '\n```';
      remaining = '```\n' + remaining;
    }
    chunks.push(chunk);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

// Slack file attachment shape (subset we care about)
interface SlackFile {
  url_private?: string;
  mimetype?: string;
  id?: string;
  name?: string;
}

type ValidImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
const VALID_IMAGE_MIMES: ReadonlyArray<ValidImageMime> = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

type ValidDocumentMime =
  | 'application/pdf'
  | 'text/plain'
  | 'text/markdown'
  | 'text/x-markdown';
const VALID_DOCUMENT_MIMES: ReadonlyArray<ValidDocumentMime> = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
];

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken = '';
  private botUserId: string | undefined;
  private botBotId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private fileSenderAllowlist: string[] = [];

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile([
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'FILE_SENDER_ALLOWLIST',
    ]);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    // Optional: comma-separated Slack user IDs allowed to send file attachments.
    // If empty/unset, all senders may share files. Set in .env as FILE_SENDER_ALLOWLIST=U123,U456.
    if (env.FILE_SENDER_ALLOWLIST) {
      this.fileSenderAllowlist = env.FILE_SENDER_ALLOWLIST.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    // Store bot token so we can authenticate file download requests
    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  // Reactions that count as approval decisions. Deliberately narrow —
  // 👀 / ⚙️ / 🔍 etc. are bot housekeeping and must not trigger approvals.
  private static readonly APPROVAL_REACTIONS = new Set([
    'white_check_mark', // ✅
    'heavy_check_mark', // ✔️
    'x', // ❌
    'no_entry_sign', // 🚫
  ]);

  private setupEventHandlers(): void {
    // reaction_added — approval-via-reaction: user reacts ✅ or ❌ to a bot message
    this.app.event('reaction_added', async ({ event }) => {
      const ev = event as unknown as {
        user: string;
        reaction: string;
        item: { type: string; channel: string; ts: string };
        item_user?: string;
        event_ts: string;
      };

      // Only message reactions (not file or channel reactions)
      if (ev.item.type !== 'message') return;

      // Ignore the bot's own housekeeping reactions (👀, ⚙️, ✅ it adds itself)
      if (ev.user === this.botUserId) return;

      // Only approval-relevant reactions
      if (!SlackChannel.APPROVAL_REACTIONS.has(ev.reaction)) return;

      const jid = `slack:${ev.item.channel}`;

      // Only for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      // Only react to messages posted by this bot
      // (item_user may be absent in edge cases — process conservatively)
      if (ev.item_user && ev.item_user !== this.botUserId) return;

      const senderName = (await this.resolveUserName(ev.user)) || ev.user;
      const timestamp = new Date(parseFloat(ev.event_ts) * 1000).toISOString();

      // Fetch the original message text so the agent knows which approval request
      // is being acted on without needing a separate Slack MCP call.
      let originalSnippet = '';
      try {
        const history = await this.app.client.conversations.history({
          channel: ev.item.channel,
          latest: ev.item.ts,
          oldest: ev.item.ts,
          inclusive: true,
          limit: 1,
        });
        const text = (history.messages as Array<{ text?: string }>)?.[0]?.text;
        if (text) originalSnippet = text.slice(0, 300);
      } catch {
        // non-critical — agent can look up by ts if needed
      }

      const content =
        `@${ASSISTANT_NAME} [Reaction: :${ev.reaction}: from ${senderName} (${ev.user}) on message ts=${ev.item.ts}]` +
        (originalSnippet ? `\nOriginal message: ${originalSnippet}` : '');

      logger.debug(
        { jid, reaction: ev.reaction, user: ev.user },
        'Reaction-based approval received',
      );

      this.opts.onMessage(jid, {
        id: ev.event_ts,
        chat_jid: jid,
        sender: ev.user,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      // Allow regular messages (no subtype), bot messages, and file shares.
      // All other subtypes (message_changed, message_deleted, etc.) are noise.
      if (subtype && subtype !== 'bot_message' && subtype !== 'file_share')
        return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      // Extract file attachments (images) if present
      const rawFiles = (msg as unknown as { files?: SlackFile[] }).files;

      // Drop messages that have neither text nor image files
      if (!msg.text && !rawFiles?.length) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Compute sender and mention data before the group check so they can
      // be used for cross-channel routing below.
      const isFromMe =
        msg.user === this.botUserId ||
        (!!msg.bot_id && msg.bot_id === this.botBotId);
      const isBotMessage = !!msg.bot_id || isFromMe;
      const senderId = msg.user || '';

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Skip for bot messages — they are already formatted and shouldn't be re-processed.
      let content = msg.text || '';
      const mentionToken = this.botUserId ? `<@${this.botUserId}>` : null;
      if (
        !isBotMessage &&
        mentionToken &&
        content.includes(mentionToken) &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
      // isBotMentioned is true when:
      //   a) Slack resolves a @mention to <@BOT_ID> (human users via UI), OR
      //   b) another agent writes literal "@BotName" (bot-to-bot via Slack MCP)
      const isBotMentioned =
        (!!mentionToken && (msg.text || '').includes(mentionToken)) ||
        new RegExp(`@${ASSISTANT_NAME}\\b`, 'i').test(msg.text || '');

      const groups = this.opts.registeredGroups();

      if (!groups[jid]) {
        // Cross-channel @mention routing: when this bot is explicitly mentioned
        // in a channel it isn't registered for, route the message to the main
        // registered group so the agent can respond.
        //
        // The original channel JID is prepended to the content so the agent
        // knows where to reply (it uses its Slack MCP to post there).
        // Bot's own messages are never re-routed (isFromMe guard).
        if (!isFromMe && isBotMentioned) {
          const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
          if (mainEntry) {
            const [mainJid] = mainEntry;
            const senderName = msg.user
              ? (await this.resolveUserName(msg.user)) || msg.user
              : (msg as unknown as { username?: string }).username || 'unknown';
            const routedContent = `[Cross-channel mention — reply in slack:${msg.channel}]\n${content}`;
            logger.info(
              { srcJid: jid, mainJid, sender: senderId },
              'Routing cross-channel @mention to main group',
            );
            this.opts.onMessage(mainJid, {
              id: msg.ts,
              chat_jid: mainJid,
              sender: senderId,
              sender_name: senderName,
              content: routedContent,
              timestamp,
              is_from_me: false,
              is_bot_message: isBotMessage,
            });
          }
        }
        return;
      }

      // ── Registered channel: full processing ──────────────────────────────

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // File attachments are only processed for non-bot messages from allowed senders.
      const filesSenderAllowed =
        !isBotMessage &&
        rawFiles?.length &&
        (this.fileSenderAllowlist.length === 0 ||
          this.fileSenderAllowlist.includes(senderId));

      if (rawFiles?.length) {
        logger.info(
          {
            fileCount: rawFiles.length,
            senderId,
            allowed: !!filesSenderAllowed,
            subtype,
          },
          'Slack message has file attachments',
        );
      }

      // Download image attachments (non-blocking; failures are soft-logged)
      const images = filesSenderAllowed
        ? await this.extractImages(rawFiles!)
        : undefined;

      // Download PDF attachments
      const documents = filesSenderAllowed
        ? await this.extractDocuments(rawFiles!)
        : undefined;

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isBotMessage,
        ...(images ? { images } : {}),
        ...(documents ? { documents } : {}),
      });
    });
  }

  /**
   * Download a private Slack file and return it as a base64-encoded Buffer.
   * Uses the bot token for authorization (Slack requires it for url_private URLs).
   * Follows up to one redirect (Slack CDN URLs return 302).
   */
  private downloadFile(
    url: string,
    followRedirect = true,
  ): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const req = https.get(
        url,
        { headers: { Authorization: `Bearer ${this.botToken}` } },
        (res) => {
          if (
            followRedirect &&
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location
          ) {
            res.resume();
            resolve(this.downloadFile(res.headers.location, false));
            return;
          }
          if (res.statusCode !== 200) {
            logger.warn(
              { url, statusCode: res.statusCode },
              'Slack file download failed — likely missing files:read scope',
            );
            res.resume();
            resolve(undefined);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', () => resolve(undefined));
        },
      );
      req.on('error', (err) => {
        logger.warn({ url, err }, 'Slack file download request error');
        resolve(undefined);
      });
    });
  }

  /**
   * Extract supported image attachments from a Slack message.
   * Downloads each image and returns it as a base64-encoded data block.
   */
  private async extractImages(
    files: SlackFile[],
  ): Promise<Array<{ media_type: ValidImageMime; data: string }> | undefined> {
    const results: Array<{ media_type: ValidImageMime; data: string }> = [];

    for (const file of files) {
      if (!file.url_private || !file.mimetype) continue;
      if (!VALID_IMAGE_MIMES.includes(file.mimetype as ValidImageMime))
        continue;

      try {
        const buf = await this.downloadFile(file.url_private);
        if (!buf) continue;
        results.push({
          media_type: file.mimetype as ValidImageMime,
          data: buf.toString('base64'),
        });
        logger.info(
          { fileId: file.id, bytes: buf.length },
          'Slack image downloaded',
        );
      } catch (err) {
        logger.warn({ fileId: file.id, err }, 'Failed to download Slack image');
      }
    }

    return results.length > 0 ? results : undefined;
  }

  /**
   * Extract document attachments (PDFs, markdown, plain text) from a Slack message.
   * Downloads each file and returns it as a base64-encoded data block.
   */
  private async extractDocuments(
    files: SlackFile[],
  ): Promise<
    | Array<{ filename: string; data: string; mime_type: ValidDocumentMime }>
    | undefined
  > {
    const results: Array<{
      filename: string;
      data: string;
      mime_type: ValidDocumentMime;
    }> = [];

    for (const file of files) {
      if (!file.url_private || !file.mimetype) continue;
      if (!VALID_DOCUMENT_MIMES.includes(file.mimetype as ValidDocumentMime))
        continue;

      try {
        const buf = await this.downloadFile(file.url_private);
        if (!buf) continue;
        const filename = file.name || (file.id ? `${file.id}` : 'document');
        results.push({
          filename,
          data: buf.toString('base64'),
          mime_type: file.mimetype as ValidDocumentMime,
        });
        logger.info(
          { fileId: file.id, mime: file.mimetype, bytes: buf.length },
          'Slack document downloaded',
        );
      } catch (err) {
        logger.warn(
          { fileId: file.id, err },
          'Failed to download Slack document',
        );
      }
    }

    return results.length > 0 ? results : undefined;
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botBotId = auth.bot_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split at line boundaries
      // and preserve code-block state across chunks
      for (const chunk of splitMessage(text)) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: chunk,
        });
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channel = jid.replace('slack:', '');
    await this.app.client.reactions.add({
      channel,
      name: emoji,
      timestamp: messageId,
    });
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const channel = jid.replace('slack:', '');
    await this.app.client.reactions.remove({
      channel,
      name: emoji,
      timestamp: messageId,
    });
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
