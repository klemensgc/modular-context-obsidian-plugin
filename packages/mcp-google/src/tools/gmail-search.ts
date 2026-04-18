// gmail_search tool: Gmail search with optional body extraction.

import type { gmail_v1 } from "googleapis";
import { callGoogleApi, createGmailClient } from "../google/client.js";
import type { GmailMessage } from "../types.js";

export interface GmailSearchInput {
  query: string;
  maxResults?: number;
  includeBody?: boolean;
}

export async function gmailSearch(
  accessToken: string,
  input: GmailSearchInput,
): Promise<GmailMessage[]> {
  const gmail = createGmailClient(accessToken);
  const maxResults = Math.min(Math.max(input.maxResults ?? 20, 1), 100);

  const listResp = await callGoogleApi("gmail.users.messages.list", () =>
    gmail.users.messages.list({
      userId: "me",
      q: input.query,
      maxResults,
    }),
  );

  const ids = listResp.data.messages ?? [];
  if (ids.length === 0) return [];

  const format = input.includeBody ? "full" : "metadata";
  const metadataHeaders = ["Subject", "From", "To", "Date"];

  const messages = await Promise.all(
    ids.map((m) =>
      callGoogleApi("gmail.users.messages.get", () =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format,
          metadataHeaders: input.includeBody ? undefined : metadataHeaders,
        }),
      ),
    ),
  );

  return messages.map((r) => toGmailMessage(r.data, input.includeBody));
}

function toGmailMessage(
  msg: gmail_v1.Schema$Message,
  includeBody: boolean | undefined,
): GmailMessage {
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const body = includeBody ? extractPlainTextBody(msg.payload) : undefined;

  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    subject: getHeader("Subject"),
    from: getHeader("From"),
    to: getHeader("To"),
    date: getHeader("Date"),
    snippet: msg.snippet ?? "",
    body,
  };
}

function extractPlainTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  // Simple case — single part with text/plain
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Multipart — search for text/plain part, fallback to text/html
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Recurse into nested multipart (e.g. multipart/mixed containing multipart/alternative)
    for (const part of payload.parts) {
      const nested = extractPlainTextBody(part);
      if (nested) return nested;
    }
    // Fallback to HTML stripped
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
  }
  return "";
}

function decodeBase64Url(data: string): string {
  const buff = Buffer.from(data, "base64url");
  return buff.toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, "")
    .replace(/<script[^>]*>.*?<\/script>/gis, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
