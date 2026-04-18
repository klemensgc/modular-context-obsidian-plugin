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
import { driveListFiles } from "./tools/drive-list-files.js";
import { driveSearch } from "./tools/drive-search.js";
import { driveDownloadFile } from "./tools/drive-download-file.js";
import { driveUploadFile } from "./tools/drive-upload-file.js";
import { docsReadDoc } from "./tools/docs-read-doc.js";
import { docsCreateDoc } from "./tools/docs-create-doc.js";
import { docsUpdateDoc } from "./tools/docs-update-doc.js";
import { sheetsListSheets } from "./tools/sheets-list-sheets.js";
import { sheetsReadRange } from "./tools/sheets-read-range.js";
import { sheetsWriteRange } from "./tools/sheets-write-range.js";
import { sheetsAppendRow } from "./tools/sheets-append-row.js";
import { sheetsCreateSpreadsheet } from "./tools/sheets-create-spreadsheet.js";
import { slidesReadPresentation } from "./tools/slides-read-presentation.js";
import { slidesCreatePresentation } from "./tools/slides-create-presentation.js";
import { slidesAddSlide } from "./tools/slides-add-slide.js";

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
    version: "1.3.0",
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

  // ============= DRIVE TOOLS =============

  reg(
    "drive_list_files",
    {
      title: "List Drive files",
      description:
        "List files in Google Drive. Optional query uses Drive query syntax (e.g. \"name contains 'report' and mimeType = 'application/pdf'\"). Returns { files, nextPageToken }.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        query: z.string().optional().describe("Drive query syntax"),
        pageSize: z.number().int().min(1).max(100).optional().describe("Default 20, max 100"),
        pageToken: z.string().optional().describe("Pagination token from previous response"),
        orderBy: z
          .string()
          .optional()
          .describe("e.g. 'modifiedTime desc', 'name', 'createdTime desc'"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("drive_list_files", args.account, async (accessToken) =>
        driveListFiles(accessToken, {
          query: args.query,
          pageSize: args.pageSize,
          pageToken: args.pageToken,
          orderBy: args.orderBy,
        }),
      ),
  );

  reg(
    "drive_search",
    {
      title: "Full-text search Drive",
      description:
        "Full-text search across Google Drive files (excludes trashed). Optionally filter by mimeType. Returns { files, nextPageToken }.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        searchText: z.string().describe("Text to search for across file content + name"),
        mimeType: z
          .string()
          .optional()
          .describe("Filter by mimeType, e.g. 'application/vnd.google-apps.document'"),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("drive_search", args.account, async (accessToken) =>
        driveSearch(accessToken, {
          searchText: args.searchText,
          mimeType: args.mimeType,
          pageSize: args.pageSize,
          pageToken: args.pageToken,
        }),
      ),
  );

  reg(
    "drive_download_file",
    {
      title: "Download Drive file",
      description:
        "Download file content. Google-native formats (docs/sheets/slides) exported as text by default " +
        "(override via exportMimeType). Binary files returned as base64.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        fileId: z.string().describe("Drive file ID"),
        exportMimeType: z
          .string()
          .optional()
          .describe(
            "Override export target for Google-native files, e.g. 'text/plain', 'text/html', 'application/pdf', 'text/csv'",
          ),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("drive_download_file", args.account, async (accessToken) =>
        driveDownloadFile(accessToken, {
          fileId: args.fileId,
          exportMimeType: args.exportMimeType,
        }),
      ),
  );

  reg(
    "drive_upload_file",
    {
      title: "Upload file to Drive",
      description:
        "Create a new file in Drive with the provided content. Use encoding 'utf-8' for text, 'base64' for binary. Optional parentFolderId places the file inside a folder.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        name: z.string().describe("Filename in Drive"),
        content: z.string().describe("File content (utf-8 text or base64)"),
        mimeType: z.string().optional().describe("Default 'application/octet-stream'"),
        encoding: z.enum(["utf-8", "base64"]).optional().describe("Default 'utf-8'"),
        parentFolderId: z.string().optional().describe("Drive folder ID to place file into"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("drive_upload_file", args.account, async (accessToken) =>
        driveUploadFile(accessToken, {
          name: args.name,
          content: args.content,
          mimeType: args.mimeType,
          encoding: args.encoding,
          parentFolderId: args.parentFolderId,
        }),
      ),
  );

  // ============= DOCS TOOLS =============

  reg(
    "docs_read_doc",
    {
      title: "Read Google Doc",
      description:
        "Fetch a Google Doc and return its plain-text content. Tables rendered with tab separators.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        documentId: z.string().describe("Google Doc document ID"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("docs_read_doc", args.account, async (accessToken) =>
        docsReadDoc(accessToken, { documentId: args.documentId }),
      ),
  );

  reg(
    "docs_create_doc",
    {
      title: "Create Google Doc",
      description:
        "Create a new Google Doc with a title and optional initial content. Returns documentId + webViewLink.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        title: z.string().describe("Document title"),
        initialContent: z.string().optional().describe("Plain text inserted at document start"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("docs_create_doc", args.account, async (accessToken) =>
        docsCreateDoc(accessToken, {
          title: args.title,
          initialContent: args.initialContent,
        }),
      ),
  );

  reg(
    "docs_update_doc",
    {
      title: "Update Google Doc",
      description:
        "Modify an existing Google Doc. Mode 'append' adds text at end; 'replace' wipes body and inserts new content.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        documentId: z.string(),
        content: z.string().describe("Text to append or replace with"),
        mode: z.enum(["append", "replace"]),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("docs_update_doc", args.account, async (accessToken) =>
        docsUpdateDoc(accessToken, {
          documentId: args.documentId,
          content: args.content,
          mode: args.mode,
        }),
      ),
  );

  // ============= SHEETS TOOLS =============

  reg(
    "sheets_list_sheets",
    {
      title: "List Google Sheets tabs",
      description:
        "Get spreadsheet metadata + list of sheet tabs (title, sheetId, row/column counts).",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        spreadsheetId: z.string().describe("Google Sheets spreadsheet ID"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("sheets_list_sheets", args.account, async (accessToken) =>
        sheetsListSheets(accessToken, { spreadsheetId: args.spreadsheetId }),
      ),
  );

  reg(
    "sheets_read_range",
    {
      title: "Read Sheets range",
      description:
        "Read values from a range using A1 notation (e.g. 'Sheet1!A1:D10'). Returns 2D array of strings.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        spreadsheetId: z.string(),
        range: z.string().describe("A1 notation, e.g. 'Sheet1!A1:D10' or 'Sheet1'"),
        majorDimension: z.enum(["ROWS", "COLUMNS"]).optional().describe("Default ROWS"),
        valueRenderOption: z
          .enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
          .optional()
          .describe("Default FORMATTED_VALUE"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("sheets_read_range", args.account, async (accessToken) =>
        sheetsReadRange(accessToken, {
          spreadsheetId: args.spreadsheetId,
          range: args.range,
          majorDimension: args.majorDimension,
          valueRenderOption: args.valueRenderOption,
        }),
      ),
  );

  reg(
    "sheets_write_range",
    {
      title: "Write Sheets range",
      description:
        "Overwrite values in a range (A1 notation). valueInputOption 'USER_ENTERED' parses formulas/dates; 'RAW' stores literal strings.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        spreadsheetId: z.string(),
        range: z.string().describe("A1 notation target"),
        values: z.array(z.array(z.string())).describe("2D array of cell values"),
        majorDimension: z.enum(["ROWS", "COLUMNS"]).optional(),
        valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional().describe("Default USER_ENTERED"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("sheets_write_range", args.account, async (accessToken) =>
        sheetsWriteRange(accessToken, {
          spreadsheetId: args.spreadsheetId,
          range: args.range,
          values: args.values,
          majorDimension: args.majorDimension,
          valueInputOption: args.valueInputOption,
        }),
      ),
  );

  reg(
    "sheets_append_row",
    {
      title: "Append row(s) to Sheets",
      description:
        "Append row(s) to the end of the data region in the given sheet (A1 range identifies sheet + start column).",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        spreadsheetId: z.string(),
        range: z.string().describe("e.g. 'Sheet1!A:Z' or 'Sheet1'"),
        values: z.array(z.array(z.string())).describe("2D array — rows of cell values"),
        valueInputOption: z.enum(["RAW", "USER_ENTERED"]).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("sheets_append_row", args.account, async (accessToken) =>
        sheetsAppendRow(accessToken, {
          spreadsheetId: args.spreadsheetId,
          range: args.range,
          values: args.values,
          valueInputOption: args.valueInputOption,
        }),
      ),
  );

  reg(
    "sheets_create_spreadsheet",
    {
      title: "Create Google Spreadsheet",
      description:
        "Create a new Google Spreadsheet with a title and optional initial sheet tab titles.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        title: z.string(),
        sheetTitles: z.array(z.string()).optional().describe("Optional initial sheet tab titles"),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("sheets_create_spreadsheet", args.account, async (accessToken) =>
        sheetsCreateSpreadsheet(accessToken, {
          title: args.title,
          sheetTitles: args.sheetTitles,
        }),
      ),
  );

  // ============= SLIDES TOOLS =============

  reg(
    "slides_read_presentation",
    {
      title: "Read Google Slides presentation",
      description:
        "Get presentation metadata + per-slide plain-text content (concatenated from all text shapes + tables).",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        presentationId: z.string(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("slides_read_presentation", args.account, async (accessToken) =>
        slidesReadPresentation(accessToken, { presentationId: args.presentationId }),
      ),
  );

  reg(
    "slides_create_presentation",
    {
      title: "Create Google Slides presentation",
      description: "Create a new presentation with a title. Returns presentationId + webViewLink.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        title: z.string(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("slides_create_presentation", args.account, async (accessToken) =>
        slidesCreatePresentation(accessToken, { title: args.title }),
      ),
  );

  reg(
    "slides_add_slide",
    {
      title: "Add slide to presentation",
      description:
        "Insert a new slide at insertionIndex (default: append at end). Layout defaults to BLANK.",
      inputSchema: {
        account: z.string().optional().describe(accountDesc),
        presentationId: z.string(),
        layout: z
          .enum([
            "BLANK",
            "TITLE",
            "TITLE_AND_BODY",
            "SECTION_HEADER",
            "TITLE_AND_TWO_COLUMNS",
            "CAPTION_ONLY",
          ])
          .optional(),
        insertionIndex: z.number().int().min(0).optional(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) =>
      run("slides_add_slide", args.account, async (accessToken) =>
        slidesAddSlide(accessToken, {
          presentationId: args.presentationId,
          layout: args.layout,
          insertionIndex: args.insertionIndex,
        }),
      ),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[FATAL] ${message}\n`);
  process.exit(1);
});
