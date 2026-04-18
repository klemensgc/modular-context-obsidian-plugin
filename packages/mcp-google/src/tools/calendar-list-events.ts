// calendar_list_events tool.

import type { calendar_v3 } from "googleapis";
import { callGoogleApi, createCalendarClient } from "../google/client.js";
import type { CalendarEvent } from "../types.js";

export interface CalendarListInput {
  calendarId?: string;
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}

export async function calendarListEvents(
  accessToken: string,
  input: CalendarListInput,
): Promise<CalendarEvent[]> {
  const calendar = createCalendarClient(accessToken);
  const calendarId = input.calendarId ?? "primary";
  const maxResults = Math.min(Math.max(input.maxResults ?? 50, 1), 2500);

  const resp = await callGoogleApi("calendar.events.list", () =>
    calendar.events.list({
      calendarId,
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    }),
  );

  return (resp.data.items ?? []).map(toCalendarEvent);
}

function toCalendarEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
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
    meetingLink: e.hangoutLink ?? extractMeetLink(e.conferenceData),
    htmlLink: e.htmlLink ?? "",
  };
}

function extractMeetLink(conf: calendar_v3.Schema$ConferenceData | undefined): string | undefined {
  if (!conf?.entryPoints) return undefined;
  const video = conf.entryPoints.find((ep) => ep.entryPointType === "video");
  return video?.uri ?? undefined;
}
