// calendar_freebusy — query free/busy for one or more calendars.

import { callGoogleApi, createCalendarClient } from "../google/client.js";

export interface CalendarFreeBusyInput {
  timeMin: string;
  timeMax: string;
  calendars?: string[];
}

export interface BusyRange {
  start: string;
  end: string;
}

export interface CalendarFreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: Array<{
    calendarId: string;
    busy: BusyRange[];
    errors?: Array<{ domain: string; reason: string }>;
  }>;
}

export async function calendarFreebusy(
  accessToken: string,
  input: CalendarFreeBusyInput,
): Promise<CalendarFreeBusyResult> {
  const calendar = createCalendarClient(accessToken);
  const items = (input.calendars ?? ["primary"]).map((id) => ({ id }));

  const resp = await callGoogleApi("calendar.freebusy.query", () =>
    calendar.freebusy.query({
      requestBody: {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items,
      },
    }),
  );

  const calendars = resp.data.calendars ?? {};
  const out: CalendarFreeBusyResult["calendars"] = [];
  for (const [calendarId, info] of Object.entries(calendars)) {
    out.push({
      calendarId,
      busy: (info.busy ?? []).map((b) => ({ start: b.start ?? "", end: b.end ?? "" })),
      errors: info.errors?.map((e) => ({ domain: e.domain ?? "", reason: e.reason ?? "" })),
    });
  }
  return {
    timeMin: resp.data.timeMin ?? input.timeMin,
    timeMax: resp.data.timeMax ?? input.timeMax,
    calendars: out,
  };
}
