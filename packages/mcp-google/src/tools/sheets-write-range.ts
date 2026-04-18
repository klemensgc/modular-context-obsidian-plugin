// sheets_write_range tool: overwrite values in a range (A1 notation).

import { callGoogleApi, createSheetsClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { SheetsWriteResult } from "../types.js";

export interface SheetsWriteRangeInput {
  spreadsheetId: string;
  range: string;
  values: string[][];
  majorDimension?: "ROWS" | "COLUMNS";
  valueInputOption?: "RAW" | "USER_ENTERED";
}

function is400(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 400;
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function sheetsWriteRange(
  accessToken: string,
  input: SheetsWriteRangeInput,
): Promise<SheetsWriteResult> {
  const sheets = createSheetsClient(accessToken);
  const majorDimension = input.majorDimension ?? "ROWS";

  const resp = await callGoogleApi("sheets.spreadsheets.values.update", () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
      valueInputOption: input.valueInputOption ?? "USER_ENTERED",
      requestBody: {
        range: input.range,
        majorDimension,
        values: input.values,
      },
    }),
  ).catch((err) => {
    if (err instanceof MCPToolError) throw err;
    if (is400(err)) {
      throw new MCPToolError(
        MCGoogleError.SHEETS_INVALID_RANGE,
        `Invalid range '${input.range}': ${String(err)}`,
        err,
      );
    }
    if (is404(err)) {
      throw new MCPToolError(
        MCGoogleError.SHEETS_NOT_FOUND,
        `Spreadsheet ${input.spreadsheetId} not found`,
        err,
      );
    }
    throw new MCPToolError(MCGoogleError.SHEETS_API_ERROR, String(err), err);
  });

  return {
    spreadsheetId: input.spreadsheetId,
    updatedRange: resp.data.updatedRange ?? undefined,
    updatedRows: resp.data.updatedRows ?? undefined,
    updatedColumns: resp.data.updatedColumns ?? undefined,
    updatedCells: resp.data.updatedCells ?? undefined,
  };
}
