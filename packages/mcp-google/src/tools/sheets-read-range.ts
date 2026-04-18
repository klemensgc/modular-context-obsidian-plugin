// sheets_read_range tool: read values from a range (A1 notation).

import { callGoogleApi, createSheetsClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { SheetsRangeData } from "../types.js";

export interface SheetsReadRangeInput {
  spreadsheetId: string;
  range: string;
  majorDimension?: "ROWS" | "COLUMNS";
  valueRenderOption?: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";
}

function is400(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number; message?: string };
  const status = anyErr.code ?? anyErr.status;
  return status === 400;
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function sheetsReadRange(
  accessToken: string,
  input: SheetsReadRangeInput,
): Promise<SheetsRangeData> {
  const sheets = createSheetsClient(accessToken);
  const majorDimension = input.majorDimension ?? "ROWS";

  const resp = await callGoogleApi("sheets.spreadsheets.values.get", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: input.spreadsheetId,
      range: input.range,
      majorDimension,
      valueRenderOption: input.valueRenderOption ?? "FORMATTED_VALUE",
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

  const raw = resp.data.values ?? [];
  const values: string[][] = raw.map((row) =>
    (row ?? []).map((cell) => (cell == null ? "" : String(cell))),
  );

  return {
    spreadsheetId: input.spreadsheetId,
    range: resp.data.range ?? input.range,
    majorDimension,
    values,
  };
}
