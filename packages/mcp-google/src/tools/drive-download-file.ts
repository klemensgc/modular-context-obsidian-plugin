// drive_download_file tool: fetch file content as text (export Google-native) or base64 (binary).

import { callGoogleApi, createDriveClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { DriveFileContent } from "../types.js";

export interface DriveDownloadInput {
  fileId: string;
  /** Override auto-inferred export mimeType for Google-native files */
  exportMimeType?: string;
}

const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

function inferExportType(sourceMimeType: string): string {
  switch (sourceMimeType) {
    case "application/vnd.google-apps.document":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    case "application/vnd.google-apps.drawing":
      return "image/png";
    default:
      return "text/plain";
  }
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function driveDownloadFile(
  accessToken: string,
  input: DriveDownloadInput,
): Promise<DriveFileContent> {
  const drive = createDriveClient(accessToken);

  // 1) Fetch metadata
  const metaResp = await callGoogleApi("drive.files.get (metadata)", () =>
    drive.files.get({
      fileId: input.fileId,
      fields: "id, name, mimeType, size",
    }),
  ).catch((err) => {
    if (err instanceof MCPToolError) throw err;
    if (is404(err)) {
      throw new MCPToolError(
        MCGoogleError.DRIVE_FILE_NOT_FOUND,
        `File ${input.fileId} not found`,
        err,
      );
    }
    throw new MCPToolError(MCGoogleError.DRIVE_API_ERROR, `drive.files.get: ${String(err)}`, err);
  });

  const meta = metaResp.data;
  const name = meta.name ?? "";
  const sourceMime = meta.mimeType ?? "application/octet-stream";
  const isGoogleNative = sourceMime.startsWith(GOOGLE_NATIVE_PREFIX);

  if (isGoogleNative) {
    const mimeType = input.exportMimeType ?? inferExportType(sourceMime);
    const resp = await callGoogleApi("drive.files.export", () =>
      drive.files.export(
        { fileId: input.fileId, mimeType },
        { responseType: "arraybuffer" },
      ),
    );
    const buf = Buffer.from(resp.data as ArrayBuffer);
    const textual = mimeType.startsWith("text/") || mimeType === "application/json";
    return {
      id: input.fileId,
      name,
      mimeType,
      content: textual ? buf.toString("utf-8") : buf.toString("base64"),
      encoding: textual ? "utf-8" : "base64",
    };
  }

  // Binary path: alt=media returns raw bytes
  const resp = await callGoogleApi("drive.files.get (media)", () =>
    drive.files.get(
      { fileId: input.fileId, alt: "media" },
      { responseType: "arraybuffer" },
    ),
  );
  const buf = Buffer.from(resp.data as ArrayBuffer);
  const textual = sourceMime.startsWith("text/") || sourceMime === "application/json";
  return {
    id: input.fileId,
    name,
    mimeType: sourceMime,
    content: textual ? buf.toString("utf-8") : buf.toString("base64"),
    encoding: textual ? "utf-8" : "base64",
  };
}
