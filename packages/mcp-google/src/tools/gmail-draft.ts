// gmail_draft tool: create a Gmail draft (not sent — user opens in web UI to send).

import { callGoogleApi, createGmailClient } from "../google/client.js";
import type { GmailDraftResult } from "../types.js";

export interface GmailDraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyToThreadId?: string;
}

export async function gmailDraft(
  accessToken: string,
  accountEmail: string,
  input: GmailDraftInput,
): Promise<GmailDraftResult> {
  const gmail = createGmailClient(accessToken);
  const mime = buildMimeMessage({ ...input, from: accountEmail });
  const raw = Buffer.from(mime).toString("base64url");

  const resp = await callGoogleApi("gmail.users.drafts.create", () =>
    gmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: {
          raw,
          threadId: input.replyToThreadId,
        },
      },
    }),
  );

  const draftId = resp.data.id ?? "";
  const messageId = resp.data.message?.id ?? "";
  return {
    draftId,
    webUrl: messageId
      ? `https://mail.google.com/mail/u/0/#drafts/${messageId}`
      : `https://mail.google.com/mail/u/0/#drafts`,
  };
}

interface MimeOptions {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyToThreadId?: string;
}

function buildMimeMessage(opts: MimeOptions): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(", ")}`);
  lines.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push(""); // blank line separator
  lines.push(opts.body);
  return lines.join("\r\n");
}

/**
 * RFC 2047 encoded-word for non-ASCII subject lines.
 * Pure ASCII passes through unchanged.
 */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
