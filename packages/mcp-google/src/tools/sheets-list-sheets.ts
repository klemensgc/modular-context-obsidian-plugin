// sheets_list_sheets tool: get spreadsheet metadata + sheet tabs.

import { callGoogleApi, createSheetsClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { SheetsListResult, SheetTab } from "../types.js";

export interface SheetsListInput {
  spreadsheetId: string;
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function sheetsListSheets(
  accessToken: string,
  input: SheetsListInput,
): Promise<SheetsListResult> {
  const sheets = createSheetsClient(accessToken);

  const resp = await callGoogleApi("sheets.spreadsheets.get", () =>
    sheets.spreadsheets.get({
      spreadsheetId: input.spreadsheetId,
      includeGridData: false,
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

  const data = resp.data;
  const tabs: SheetTab[] = (data.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? 0,
    title: s.properties?.title ?? "",
    index: s.properties?.index ?? undefined,
    rowCount: s.properties?.gridProperties?.rowCount ?? undefined,
    columnCount: s.properties?.gridProperties?.columnCount ?? undefined,
  }));

  return {
    spreadsheetId: data.spreadsheetId ?? input.spreadsheetId,
    title: data.properties?.title ?? "",
    sheets: tabs,
    webViewLink: data.spreadsheetUrl ?? undefined,
  };
}
