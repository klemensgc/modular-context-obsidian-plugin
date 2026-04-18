// gmail_send — actually send (not draft).
// Reuses MIME builder pattern from gmail_draft.

import { callGoogleApi, createGmailClient } from "../google/client.js";

export interface GmailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  replyToThreadId?: string;
}

export interface GmailSendResult {
  messageId: string;
  threadId: string;
  webUrl: string;
}

export async function gmailSend(
  accessToken: string,
  accountEmail: string,
  input: GmailSendInput,
): Promise<GmailSendResult> {
  const gmail = createGmailClient(accessToken);
  const mime = buildMimeMessage({ ...input, from: accountEmail });
  const raw = Buffer.from(mime).toString("base64url");

  const resp = await callGoogleApi("gmail.users.messages.send", () =>
    gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: input.replyToThreadId,
      },
    }),
  );

  const messageId = resp.data.id ?? "";
  const threadId = resp.data.threadId ?? "";
  return {
    messageId,
    threadId,
    webUrl: messageId
      ? `https://mail.google.com/mail/u/0/#inbox/${messageId}`
      : `https://mail.google.com/mail/u/0/#inbox`,
  };
}

interface MimeOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}

function buildMimeMessage(opts: MimeOptions): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(", ")}`);
  if (opts.bcc && opts.bcc.length > 0) lines.push(`Bcc: ${opts.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 7bit");
  lines.push("");
  lines.push(opts.body);
  return lines.join("\r\n");
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
