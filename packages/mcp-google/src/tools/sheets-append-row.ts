// sheets_append_row tool: append row(s) to the end of a sheet's data region.

import { callGoogleApi, createSheetsClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { SheetsWriteResult } from "../types.js";

export interface SheetsAppendRowInput {
  spreadsheetId: string;
  /** Range that identifies the sheet + start column, e.g. 'Sheet1!A:Z' or 'Sheet1' */
  range: string;
  values: string[][];
  valueInputOption?: "RAW" | "USER_ENTERED";
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function sheetsAppendRow(
  accessToken: string,
  input: SheetsAppendRowInput,
): Promise<SheetsWriteResult> {
  const sheets = createSheetsClient(accessToken);

  const resp = await callGoogleApi("sheets.spreadsheets.values.append", () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
      valueInputOption: input.valueInputOption ?? "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: input.values },
    }),
  ).catch((err) => {
    if (err instanceof MCPToolError) throw err;
    if (is404(err)) {
      throw new MCPToolError(
        MCGoogleError.SHEETS_NOT_FOUND,
        `Spreadsheet ${input.spreadsheetId} not found`,
        err,
      );
    }
    throw new MCPToolError(MCGoogleError.SHEETS_API_ERROR, String(err), err);
  });

  const u = resp.data.updates;
  return {
    spreadsheetId: input.spreadsheetId,
    updatedRange: u?.updatedRange ?? undefined,
    updatedRows: u?.updatedRows ?? undefined,
    updatedColumns: u?.updatedColumns ?? undefined,
    updatedCells: u?.updatedCells ?? undefined,
  };
}
