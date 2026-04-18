// drive_list_files tool: list files in Google Drive with optional query.

import type { drive_v3 } from "googleapis";
import { callGoogleApi, createDriveClient } from "../google/client.js";
import type { DriveFile, DriveFileList } from "../types.js";

export interface DriveListFilesInput {
  query?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
}

const FIELDS = "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)";

export async function driveListFiles(
  accessToken: string,
  input: DriveListFilesInput,
): Promise<DriveFileList> {
  const drive = createDriveClient(accessToken);
  const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 100);

  const resp = await callGoogleApi("drive.files.list", () =>
    drive.files.list({
      q: input.query,
      pageSize,
      pageToken: input.pageToken,
      orderBy: input.orderBy,
      fields: FIELDS,
    }),
  );

  return {
    files: (resp.data.files ?? []).map(toDriveFile),
    nextPageToken: resp.data.nextPageToken ?? null,
  };
}

export function toDriveFile(f: drive_v3.Schema$File): DriveFile {
  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "application/octet-stream",
    modifiedTime: f.modifiedTime ?? undefined,
    size: f.size ?? undefined,
    webViewLink: f.webViewLink ?? undefined,
  };
}
