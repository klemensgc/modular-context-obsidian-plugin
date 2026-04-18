// docs_read_doc tool: fetch a Google Doc and return plain text.

import { callGoogleApi, createDocsClient } from "../google/client.js";
import { extractPlainText } from "../google/docs-helpers.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { DocDocument } from "../types.js";

export interface DocsReadDocInput {
  documentId: string;
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function docsReadDoc(
  accessToken: string,
  input: DocsReadDocInput,
): Promise<DocDocument> {
  const docs = createDocsClient(accessToken);

  const resp = await callGoogleApi("docs.documents.get", () =>
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

  const doc = resp.data;
  return {
    documentId: doc.documentId ?? input.documentId,
    title: doc.title ?? "",
    content: extractPlainText(doc),
    revisionId: doc.revisionId ?? undefined,
    format: "plain",
  };
}
