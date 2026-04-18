// MCP Google Workspace Server — stdio transport, multi-account (ADR-005).
// Spawned by Claude Code via .mcp.json.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getValidAccessToken } from "./auth/token-loader.js";
import { Logger } from "./logger.js";
import { MCGoogleError, MCPToolError, parseEnv, type ServerEnv } from "./types.js";

import { gmailSearch } from "./tools/gmail-search.js";
import { gmailDraft } from "./tools/gmail-draft.js";
import { gmailSend } from "./tools/gmail-send.js";
import { gmailModifyLabels } from "./tools/gmail-modify-labels.js";
import { calendarListEvents } from "./tools/calendar-list-events.js";
import { calendarCreateEvent } from "./tools/calendar-create-event.js";
import { calendarListCalendars } from "./tools/calendar-list-calendars.js";
import { calendarUpdateEvent } from "./tools/calendar-update-event.js";
import { calendarDeleteEvent } from "./tools/calendar-delete-event.js";
import { calendarFreebusy } from "./tools/calendar-freebusy.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = new Logger(env);

  logger.info("Starting mcp-google-workspace server", {
    accountsDir: env.accountsDir ?? "(legacy)",
    accountsIndexPath: env.accountsIndexPath ?? "(legacy)",
    logLevel: env.logLevel,
  });

  const server = new McpServer({
    name: "mcp-google-workspace",
    version: "1.1.0",
  });

  registerTools(server, env, logger);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stdin.on("end", () => {
    logger.info("stdin closed, shutting down");
    process.exit(0);
  });

  logger.info("Server ready — listening on stdio");
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function registerTools(server: McpServer, env: ServerEnv, logger: Logger): void {
  // Shared wrapper: resolve account token then run tool, map errors to MCP content.
  async function run(
    toolName: string,
    accountId: string | undefined,
    fn: (accessToken: string, accountEmail: string) => Promise<unknown>,
  ): Promise<ToolResult> {
    try {
      const { accessToken, accountEmail } = await getValidAccessToken(env, accountId, logger);
      const result = await fn(accessToken, accountEmail);
      logger.debug(`${toolName} OK`, { account: accountEmail });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof MCPToolError) {
        logger.warn(`${toolName} failed`, { code: err.code, message: err.message });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`${toolName} unexpected error`, { message });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: MCGoogleError.UNKNOWN, message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  // Bypass MCP SDK + Zod deep-inference TS2589 issue (see W2 implementation notes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = server.registerTool.bind(server) as any;

  // Shared account param description
  const accountDesc =
    "Optional: email of Google account to use (e.g. 'k@fundacjaedisona.pl'). " +
    "Default = primary account. Unknown email → ACCOUNT_NOT_FOUND error.";

  // ============= GMAIL TOOLS =============

  reg(
    "gmail_search",
    {
      title: "Search Gmail",
      description:
        "Search Gmail messages using Gmail's native query syntax (e.g. 'is:unread from:x@y.com after:2026-04-01'). Returns array of { id, subject, from, to, snippet, date, body? }.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        query: z.string().describe("Gmail search query"),
        maxResults: z.number().int().min(1).max(100).optional().describe("Default 20, max 100"),
        includeBody: z.boolean().optional().describe("Include plaintext body (default false)"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("gmail_search", args.account, async (accessToken) =>
        gmailSearch(accessToken, {
          query: args.query,
          maxResults: args.maxResults,
          includeBody: args.includeBody,
        }),
      ),
  );

  reg(
    "gmail_draft",
    {
      title: "Create Gmail draft",
      description:
        "Create a Gmail draft (NOT sent — user opens webUrl in Gmail to review and send manually).",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        subject: z.string(),
        body: z.string(),
        replyToThreadId: z.string().optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("gmail_draft", args.account, async (accessToken, accountEmail) =>
        gmailDraft(accessToken, accountEmail, {
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          replyToThreadId: args.replyToThreadId,
        }),
      ),
  );

  reg(
    "gmail_send",
    {
      title: "Send Gmail message",
      description:
        "Send a Gmail message immediately. Use gmail_draft if you want user review before send.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        to: z.array(z.string().email()).min(1),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        subject: z.string(),
        body: z.string(),
        replyToThreadId: z.string().optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("gmail_send", args.account, async (accessToken, accountEmail) =>
        gmailSend(accessToken, accountEmail, {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          body: args.body,
          replyToThreadId: args.replyToThreadId,
        }),
      ),
  );

  reg(
    "gmail_modify_labels",
    {
      title: "Modify Gmail message labels",
      description:
        "Add/remove labels on a message. Presets: INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, SENT. " +
        "Archive = removeLabels: ['INBOX']. Mark read = removeLabels: ['UNREAD']. Star = addLabels: ['STARRED']. " +
        "Custom labels accepted by name (resolved via users.labels.list).",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        messageId: z.string(),
        addLabels: z.array(z.string()).optional(),
        removeLabels: z.array(z.string()).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("gmail_modify_labels", args.account, async (accessToken) =>
        gmailModifyLabels(accessToken, {
          messageId: args.messageId,
          addLabels: args.addLabels,
          removeLabels: args.removeLabels,
        }),
      ),
  );

  // ============= CALENDAR TOOLS =============

  reg(
    "calendar_list_calendars",
    {
      title: "List calendars",
      description:
        "List all calendars the account has access to (primary + secondary + shared). " +
        "Use returned id as calendarId param to other calendar tools.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("calendar_list_calendars", args.account, async (accessToken) =>
        calendarListCalendars(accessToken, {}),
      ),
  );

  reg(
    "calendar_list_events",
    {
      title: "List calendar events",
      description:
        "List events from a Google Calendar in a time range. Defaults to primary calendar.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        calendarId: z.string().optional().describe("Default 'primary'"),
        timeMin: z.string().describe("ISO 8601 inclusive"),
        timeMax: z.string().describe("ISO 8601 exclusive"),
        maxResults: z.number().int().min(1).max(2500).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("calendar_list_events", args.account, async (accessToken) =>
        calendarListEvents(accessToken, {
          calendarId: args.calendarId,
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          maxResults: args.maxResults,
        }),
      ),
  );

  reg(
    "calendar_create_event",
    {
      title: "Create calendar event",
      description:
        "Create a new event. Does NOT email attendees by default (sendUpdates='none').",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        calendarId: z.string().optional(),
        summary: z.string(),
        description: z.string().optional(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string().email()).optional(),
        location: z.string().optional(),
        sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("calendar_create_event", args.account, async (accessToken) =>
        calendarCreateEvent(accessToken, {
          calendarId: args.calendarId,
          summary: args.summary,
          description: args.description,
          start: args.start,
          end: args.end,
          attendees: args.attendees,
          location: args.location,
          sendUpdates: args.sendUpdates,
        }),
      ),
  );

  reg(
    "calendar_update_event",
    {
      title: "Update calendar event",
      description:
        "Modify an existing event via events.patch (only provided fields are changed).",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        calendarId: z.string().optional(),
        eventId: z.string(),
        summary: z.string().optional(),
        description: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        attendees: z.array(z.string().email()).optional(),
        location: z.string().optional(),
        sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("calendar_update_event", args.account, async (accessToken) =>
        calendarUpdateEvent(accessToken, {
          calendarId: args.calendarId,
          eventId: args.eventId,
          summary: args.summary,
          description: args.description,
          start: args.start,
          end: args.end,
          attendees: args.attendees,
          location: args.location,
          sendUpdates: args.sendUpdates,
        }),
      ),
  );

  reg(
    "calendar_delete_event",
    {
      title: "Delete calendar event",
      description: "Delete an event. sendUpdates='none' default.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        calendarId: z.string().optional(),
        eventId: z.string(),
        sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("calendar_delete_event", args.account, async (accessToken) =>
        calendarDeleteEvent(accessToken, {
          calendarId: args.calendarId,
          eventId: args.eventId,
          sendUpdates: args.sendUpdates,
        }),
      ),
  );

  reg(
    "calendar_freebusy",
    {
      title: "Check calendar availability",
      description:
        "Query free/busy windows across one or more calendars. Useful for 'find time to meet'.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        timeMin: z.string(),
        timeMax: z.string(),
        calendars: z
          .array(z.string())
          .optional()
          .describe("Default ['primary']. Use calendar_list_calendars to enumerate."),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("calendar_freebusy", args.account, async (accessToken) =>
        calendarFreebusy(accessToken, {
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          calendars: args.calendars,
        }),
      ),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[FATAL] ${message}\n`);
  process.exit(1);
});
