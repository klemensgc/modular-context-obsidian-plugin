// drive_search tool: full-text search over Google Drive files.

import { callGoogleApi, createDriveClient } from "../google/client.js";
import type { DriveFileList } from "../types.js";
import { toDriveFile } from "./drive-list-files.js";

export interface DriveSearchInput {
  searchText: string;
  mimeType?: string;
  pageSize?: number;
  pageToken?: string;
}

const FIELDS = "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)";

function escapeQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function driveSearch(
  accessToken: string,
  input: DriveSearchInput,
): Promise<DriveFileList> {
  const drive = createDriveClient(accessToken);
  const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 100);

  const parts: string[] = [`fullText contains '${escapeQueryLiteral(input.searchText)}'`];
  if (input.mimeType) {
    parts.push(`mimeType = '${escapeQueryLiteral(input.mimeType)}'`);
  }
  parts.push("trashed = false");
  const q = parts.join(" and ");

  const resp = await callGoogleApi("drive.files.list (search)", () =>
    drive.files.list({
      q,
      pageSize,
      pageToken: input.pageToken,
      fields: FIELDS,
    }),
  );

  return {
    files: (resp.data.files ?? []).map(toDriveFile),
    nextPageToken: resp.data.nextPageToken ?? null,
  };
}
