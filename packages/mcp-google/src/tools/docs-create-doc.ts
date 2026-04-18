// docs_create_doc tool: create a new Google Doc with optional initial content.

import { callGoogleApi, createDocsClient } from "../google/client.js";
import { buildInsertTextRequests } from "../google/docs-helpers.js";
import type { DocCreateResult } from "../types.js";

export interface DocsCreateDocInput {
  title: string;
  initialContent?: string;
}

export async function docsCreateDoc(
  accessToken: string,
  input: DocsCreateDocInput,
): Promise<DocCreateResult> {
  const docs = createDocsClient(accessToken);

  const createResp = await callGoogleApi("docs.documents.create", () =>
    docs.documents.create({ requestBody: { title: input.title } }),
  );

  const documentId = createResp.data.documentId ?? "";

  if (input.initialContent && input.initialContent.length > 0 && documentId) {
    await callGoogleApi("docs.documents.batchUpdate (initialContent)", () =>
      docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: buildInsertTextRequests(input.initialContent ?? "", 1),
        },
      }),
    );
  }

  return {
    documentId,
    title: createResp.data.title ?? input.title,
    webViewLink: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}
