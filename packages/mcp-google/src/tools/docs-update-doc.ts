// docs_update_doc tool: append or replace content in an existing Google Doc.

import { callGoogleApi, createDocsClient } from "../google/client.js";
import {
  buildInsertTextRequests,
  buildReplaceAllRequests,
  getDocEndIndex,
} from "../google/docs-helpers.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { DocUpdateResult } from "../types.js";

export interface DocsUpdateDocInput {
  documentId: string;
  content: string;
  mode: "append" | "replace";
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function docsUpdateDoc(
  accessToken: string,
  input: DocsUpdateDocInput,
): Promise<DocUpdateResult> {
  const docs = createDocsClient(accessToken);

  const getResp = await callGoogleApi("docs.documents.get (pre-update)", () =>
    docs.documents.get({ documentId: input.documentId }),
  ).catch((err) => {
    if (err instanceof MCPToolError) throw err;
    if (is404(err)) {
      throw new MCPToolError(
        MCGoogleError.DOCS_NOT_FOUND,
        `Document ${input.documentId} not found`,
        err,
      );
    }
    throw new MCPToolError(MCGoogleError.DOCS_API_ERROR, `docs.documents.get: ${String(err)}`, err);
  });

  const doc = getResp.data;
  const requests =
    input.mode === "replace"
      ? buildReplaceAllRequests(doc, input.content)
      : buildInsertTextRequests(input.content, getDocEndIndex(doc));

  const updateResp = await callGoogleApi("docs.documents.batchUpdate", () =>
    docs.documents.batchUpdate({
      documentId: input.documentId,
      requestBody: { requests },
    }),
  );

  return {
    documentId: input.documentId,
    revisionId: updateResp.data.writeControl?.requiredRevisionId ?? undefined,
    mode: input.mode,
  };
}
