// calendar_delete_event — delete event.

import { callGoogleApi, createCalendarClient } from "../google/client.js";

export interface CalendarDeleteInput {
  calendarId?: string;
  eventId: string;
  sendUpdates?: "all" | "externalOnly" | "none";
}

export interface CalendarDeleteResult {
  deleted: true;
  eventId: string;
  calendarId: string;
}

export async function calendarDeleteEvent(
  accessToken: string,
  input: CalendarDeleteInput,
): Promise<CalendarDeleteResult> {
  const calendar = createCalendarClient(accessToken);
  const calendarId = input.calendarId ?? "primary";

  await callGoogleApi("calendar.events.delete", () =>
    calendar.events.delete({
      calendarId,
      eventId: input.eventId,
      sendUpdates: input.sendUpdates ?? "none",
    }),
  );

  return { deleted: true, eventId: input.eventId, calendarId };
}
