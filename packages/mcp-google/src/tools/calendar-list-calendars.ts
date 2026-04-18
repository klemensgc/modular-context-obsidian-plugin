// calendar_list_calendars — enumerate calendars the user has access to.

import { callGoogleApi, createCalendarClient } from "../google/client.js";

export interface CalendarListCalendarsInput {
  /** Unused — kept for API symmetry. */
  _account?: string;
}

export interface CalendarSummary {
  id: string;
  summary: string;
  description?: string;
  primary: boolean;
  accessRole: string;
  backgroundColor?: string;
  timeZone?: string;
}

export async function calendarListCalendars(
  accessToken: string,
  _input: CalendarListCalendarsInput,
): Promise<CalendarSummary[]> {
  const calendar = createCalendarClient(accessToken);
  const resp = await callGoogleApi("calendar.calendarList.list", () =>
    calendar.calendarList.list({ maxResults: 250, showHidden: false }),
  );
  const items = resp.data.items ?? [];
  return items.map((c) => ({
    id: c.id ?? "",
    summary: c.summary ?? "(no title)",
    description: c.description ?? undefined,
    primary: Boolean(c.primary),
    accessRole: c.accessRole ?? "reader",
    backgroundColor: c.backgroundColor ?? undefined,
    timeZone: c.timeZone ?? undefined,
  }));
}
