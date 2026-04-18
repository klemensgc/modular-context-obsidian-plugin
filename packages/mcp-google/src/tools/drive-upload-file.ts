// drive_upload_file tool: create a new file in Drive (simple multipart upload).

import { Readable } from "node:stream";
import { callGoogleApi, createDriveClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { DriveUploadResult } from "../types.js";

export interface DriveUploadInput {
  name: string;
  content: string;
  mimeType?: string;
  encoding?: "utf-8" | "base64";
  parentFolderId?: string;
}

function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

export async function driveUploadFile(
  accessToken: string,
  input: DriveUploadInput,
): Promise<DriveUploadResult> {
  const drive = createDriveClient(accessToken);
  const encoding = input.encoding ?? "utf-8";
  const mimeType = input.mimeType ?? "application/octet-stream";
  const buf = Buffer.from(input.content, encoding);

  try {
    const resp = await callGoogleApi("drive.files.create", () =>
      drive.files.create({
        requestBody: {
          name: input.name,
          parents: input.parentFolderId ? [input.parentFolderId] : undefined,
        },
        media: {
          mimeType,
          body: bufferToStream(buf),
        },
        fields: "id, name, mimeType, webViewLink",
      }),
    );
    const f = resp.data;
    return {
      id: f.id ?? "",
      name: f.name ?? input.name,
      mimeType: f.mimeType ?? mimeType,
      webViewLink: f.webViewLink ?? undefined,
    };
  } catch (err) {
    if (err instanceof MCPToolError) throw err;
    throw new MCPToolError(
      MCGoogleError.DRIVE_UPLOAD_FAILED,
      `Upload failed: ${String(err)}`,
      err,
    );
  }
}
