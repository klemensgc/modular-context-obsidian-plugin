// calendar_update_event — modify an existing event via events.patch.

import { callGoogleApi, createCalendarClient } from "../google/client.js";
import type { CalendarEvent } from "../types.js";

export interface CalendarUpdateInput {
  calendarId?: string;
  eventId: string;
  summary?: string;
  description?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  location?: string;
  sendUpdates?: "all" | "externalOnly" | "none";
}

export async function calendarUpdateEvent(
  accessToken: string,
  input: CalendarUpdateInput,
): Promise<CalendarEvent> {
  const calendar = createCalendarClient(accessToken);
  const calendarId = input.calendarId ?? "primary";

  const patchBody: Record<string, unknown> = {};
  if (input.summary !== undefined) patchBody.summary = input.summary;
  if (input.description !== undefined) patchBody.description = input.description;
  if (input.start) patchBody.start = { dateTime: input.start };
  if (input.end) patchBody.end = { dateTime: input.end };
  if (input.attendees !== undefined) {
    patchBody.attendees = input.attendees.map((email) => ({ email }));
  }
  if (input.location !== undefined) patchBody.location = input.location;

  const resp = await callGoogleApi("calendar.events.patch", () =>
    calendar.events.patch({
      calendarId,
      eventId: input.eventId,
      sendUpdates: input.sendUpdates ?? "none",
      requestBody: patchBody,
    }),
  );

  const e = resp.data;
  return {
    id: e.id ?? input.eventId,
    summary: e.summary ?? "",
    description: e.description ?? undefined,
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? "",
      displayName: a.displayName ?? undefined,
      responseStatus: a.responseStatus ?? undefined,
      optional: a.optional ?? undefined,
    })),
    location: e.location ?? undefined,
    meetingLink: e.hangoutLink ?? undefined,
    htmlLink: e.htmlLink ?? "",
  };
}
