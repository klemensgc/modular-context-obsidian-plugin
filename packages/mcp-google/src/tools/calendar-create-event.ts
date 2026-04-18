// calendar_create_event tool.

import { callGoogleApi, createCalendarClient } from "../google/client.js";
import type { CalendarEvent } from "../types.js";

export interface CalendarCreateInput {
  calendarId?: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees?: string[];
  location?: string;
  sendUpdates?: "all" | "externalOnly" | "none";
}

export async function calendarCreateEvent(
  accessToken: string,
  input: CalendarCreateInput,
): Promise<CalendarEvent> {
  const calendar = createCalendarClient(accessToken);
  const calendarId = input.calendarId ?? "primary";

  const resp = await callGoogleApi("calendar.events.insert", () =>
    calendar.events.insert({
      calendarId,
      sendUpdates: input.sendUpdates ?? "none",
      requestBody: {
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.start },
        end: { dateTime: input.end },
        attendees: input.attendees?.map((email) => ({ email })),
        location: input.location,
      },
    }),
  );

  const e = resp.data;
  return {
    id: e.id ?? "",
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
