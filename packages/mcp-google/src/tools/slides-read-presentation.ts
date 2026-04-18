// slides_read_presentation tool: get presentation metadata + slide text summaries.

import type { slides_v1 } from "googleapis";
import { callGoogleApi, createSlidesClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { SlidesPresentation, SlideSummary } from "../types.js";

export interface SlidesReadInput {
  presentationId: string;
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

function extractSlideText(slide: slides_v1.Schema$Page): string {
  const parts: string[] = [];
  for (const el of slide.pageElements ?? []) {
    const textElements = el.shape?.text?.textElements ?? [];
    for (const t of textElements) {
      const content = t.textRun?.content;
      if (content) parts.push(content);
    }
    // Tables — walk cells
    for (const row of el.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        for (const t of cell.text?.textElements ?? []) {
          const content = t.textRun?.content;
          if (content) parts.push(content);
        }
      }
    }
  }
  return parts.join("").trim();
}

export async function slidesReadPresentation(
  accessToken: string,
  input: SlidesReadInput,
): Promise<SlidesPresentation> {
  const slides = createSlidesClient(accessToken);

  const resp = await callGoogleApi("slides.presentations.get", () =>
    slides.presentations.get({ presentationId: input.presentationId }),
  ).catch((err) => {
    if (err instanceof MCPToolError) throw err;
    if (is404(err)) {
      throw new MCPToolError(
        MCGoogleError.SLIDES_NOT_FOUND,
        `Presentation ${input.presentationId} not found`,
        err,
      );
    }
    throw new MCPToolError(MCGoogleError.SLIDES_API_ERROR, String(err), err);
  });

  const data = resp.data;
  const slideList = data.slides ?? [];
  const summaries: SlideSummary[] = slideList.map((s) => ({
    objectId: s.objectId ?? "",
    text: extractSlideText(s),
  }));

  return {
    presentationId: data.presentationId ?? input.presentationId,
    title: data.title ?? "",
    slideCount: slideList.length,
    slides: summaries,
    revisionId: data.revisionId ?? undefined,
  };
}
