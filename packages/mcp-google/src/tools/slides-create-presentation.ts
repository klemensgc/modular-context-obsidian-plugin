// slides_create_presentation tool: create new presentation with a title.

import { callGoogleApi, createSlidesClient } from "../google/client.js";
import type { SlidesCreateResult } from "../types.js";

export interface SlidesCreateInput {
  title: string;
}

export async function slidesCreatePresentation(
  accessToken: string,
  input: SlidesCreateInput,
): Promise<SlidesCreateResult> {
  const slides = createSlidesClient(accessToken);

  const resp = await callGoogleApi("slides.presentations.create", () =>
    slides.presentations.create({ requestBody: { title: input.title } }),
  );

  const presentationId = resp.data.presentationId ?? "";
  return {
    presentationId,
    title: resp.data.title ?? input.title,
    webViewLink: `https://docs.google.com/presentation/d/${presentationId}/edit`,
  };
}
