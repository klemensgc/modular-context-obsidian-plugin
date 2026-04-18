// slides_add_slide tool: insert a new slide at the end (or at given index).

import { callGoogleApi, createSlidesClient } from "../google/client.js";
import { MCGoogleError, MCPToolError } from "../types.js";
import type { SlidesAddSlideResult } from "../types.js";

export interface SlidesAddSlideInput {
  presentationId: string;
  /** Predefined layout — default BLANK. Common: TITLE, TITLE_AND_BODY, SECTION_HEADER, TITLE_AND_TWO_COLUMNS, BLANK */
  layout?:
    | "BLANK"
    | "TITLE"
    | "TITLE_AND_BODY"
    | "SECTION_HEADER"
    | "TITLE_AND_TWO_COLUMNS"
    | "CAPTION_ONLY";
  /** 0-based insertion index. Default: append at end. */
  insertionIndex?: number;
}

function is404(err: unknown): boolean {
  const anyErr = err as { code?: number; status?: number };
  const status = anyErr.code ?? anyErr.status;
  return status === 404;
}

export async function slidesAddSlide(
  accessToken: string,
  input: SlidesAddSlideInput,
): Promise<SlidesAddSlideResult> {
  const slides = createSlidesClient(accessToken);
  const layout = input.layout ?? "BLANK";

  const resp = await callGoogleApi("slides.presentations.batchUpdate (createSlide)", () =>
    slides.presentations.batchUpdate({
      presentationId: input.presentationId,
      requestBody: {
        requests: [
          {
            createSlide: {
              insertionIndex:
                typeof input.insertionIndex === "number" ? input.insertionIndex : undefined,
              slideLayoutReference: { predefinedLayout: layout },
            },
          },
        ],
      },
    }),
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

  const reply = resp.data.replies?.[0];
  const slideObjectId = reply?.createSlide?.objectId ?? "";
  return {
    presentationId: input.presentationId,
    slideObjectId,
    index: input.insertionIndex ?? -1,
  };
}
