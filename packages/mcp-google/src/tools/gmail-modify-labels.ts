// gmail_modify_labels — add/remove labels on a message.
// Preset system labels: INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, SENT
// Custom labels: pass by name — tool resolves name → label ID via users.labels.list

import { callGoogleApi, createGmailClient } from "../google/client.js";

const SYSTEM_LABELS = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
  "SENT",
  "DRAFT",
  "CHAT",
]);

export interface GmailModifyLabelsInput {
  messageId: string;
  addLabels?: string[];
  removeLabels?: string[];
}

export interface GmailModifyLabelsResult {
  messageId: string;
  labels: string[];
}

export async function gmailModifyLabels(
  accessToken: string,
  input: GmailModifyLabelsInput,
): Promise<GmailModifyLabelsResult> {
  const gmail = createGmailClient(accessToken);

  const addRaw = input.addLabels ?? [];
  const removeRaw = input.removeLabels ?? [];
  if (addRaw.length === 0 && removeRaw.length === 0) {
    throw new Error("At least one of addLabels or removeLabels must be non-empty");
  }

  const needsResolution =
    addRaw.some((l) => !SYSTEM_LABELS.has(l.toUpperCase())) ||
    removeRaw.some((l) => !SYSTEM_LABELS.has(l.toUpperCase()));

  let nameToId = new Map<string, string>();
  if (needsResolution) {
    const labelsResp = await callGoogleApi("gmail.users.labels.list", () =>
      gmail.users.labels.list({ userId: "me" }),
    );
    for (const l of labelsResp.data.labels ?? []) {
      if (l.name && l.id) nameToId.set(l.name.toLowerCase(), l.id);
    }
  }

  const resolveLabel = (raw: string): string => {
    const upper = raw.toUpperCase();
    if (SYSTEM_LABELS.has(upper)) return upper;
    const resolved = nameToId.get(raw.toLowerCase());
    if (!resolved) {
      throw new Error(`Unknown label: "${raw}" (not a system label and not in user labels)`);
    }
    return resolved;
  };

  const addLabelIds = addRaw.map(resolveLabel);
  const removeLabelIds = removeRaw.map(resolveLabel);

  const resp = await callGoogleApi("gmail.users.messages.modify", () =>
    gmail.users.messages.modify({
      userId: "me",
      id: input.messageId,
      requestBody: {
        addLabelIds: addLabelIds.length > 0 ? addLabelIds : undefined,
        removeLabelIds: removeLabelIds.length > 0 ? removeLabelIds : undefined,
      },
    }),
  );

  return {
    messageId: resp.data.id ?? input.messageId,
    labels: resp.data.labelIds ?? [],
  };
}
