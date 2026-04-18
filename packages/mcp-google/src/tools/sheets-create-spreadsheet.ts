// sheets_create_spreadsheet tool: create a new spreadsheet with optional initial sheet titles.

import { callGoogleApi, createSheetsClient } from "../google/client.js";
import type { SheetsCreateResult } from "../types.js";

export interface SheetsCreateInput {
  title: string;
  /** Optional initial sheet tab titles — defaults to single sheet "Sheet1" */
  sheetTitles?: string[];
}

export async function sheetsCreateSpreadsheet(
  accessToken: string,
  input: SheetsCreateInput,
): Promise<SheetsCreateResult> {
  const sheets = createSheetsClient(accessToken);

  const sheetProps =
    input.sheetTitles && input.sheetTitles.length > 0
      ? input.sheetTitles.map((title) => ({ properties: { title } }))
      : undefined;

  const resp = await callGoogleApi("sheets.spreadsheets.create", () =>
    sheets.spreadsheets.create({
      requestBody: {
        properties: { title: input.title },
        sheets: sheetProps,
      },
    }),
  );

  const spreadsheetId = resp.data.spreadsheetId ?? "";
  return {
    spreadsheetId,
    title: resp.data.properties?.title ?? input.title,
    webViewLink:
      resp.data.spreadsheetUrl ??
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}
