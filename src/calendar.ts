import { google, calendar_v3 } from "googleapis";
import type { AppConfig } from "./config";

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
}

function buildOAuthClient(config: AppConfig) {
  const client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  client.setCredentials({ refresh_token: config.google.refreshToken });
  return client;
}

function toCalendarEvent(event: {
  id?: string | null;
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  start?: { date?: string | null; dateTime?: string | null } | null;
  end?: { date?: string | null; dateTime?: string | null } | null;
}): CalendarEvent {
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  const start = new Date((event.start?.dateTime ?? event.start?.date) as string);
  const end = new Date((event.end?.dateTime ?? event.end?.date) as string);
  return {
    id: event.id ?? "",
    title: event.summary ?? "(無標題)",
    start,
    end,
    allDay,
    location: event.location ?? undefined,
    description: event.description ?? undefined,
  };
}

/** 列出使用者「有勾選顯示」的所有行事曆 ID(不只 primary),對應 Google Calendar UI 左側清單。 */
async function listCalendarIds(calendar: calendar_v3.Calendar): Promise<string[]> {
  const res = await calendar.calendarList.list();
  return (res.data.items ?? [])
    .filter((entry) => entry.selected !== false)
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id));
}

async function listEventsAcrossCalendars(
  calendar: calendar_v3.Calendar,
  params: { timeMin: string; timeMax: string }
): Promise<CalendarEvent[]> {
  const calendarIds = await listCalendarIds(calendar);

  const eventsByCalendar = await Promise.all(
    calendarIds.map(async (calendarId) => {
      const res = await calendar.events.list({
        calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        singleEvents: true,
        orderBy: "startTime",
      });
      return (res.data.items ?? []).map(toCalendarEvent);
    })
  );

  return eventsByCalendar.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
}

const TAIPEI_TIME_ZONE = "Asia/Taipei";

/** 取得 `day` 這個時間點在 Asia/Taipei 時區對應的日期(YYYY-MM-DD)。
 * Cloud Functions 執行環境的系統時區是 UTC,不能直接用 Date 的 setHours 算「當地日期」的起訖,
 * 否則在台北時間清晨觸發時,UTC 當下其實還是前一天,會抓到錯的一天。 */
function getTaipeiDateKey(day: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TAIPEI_TIME_ZONE }).format(day);
}

/** 取得指定日期(預設今天,Asia/Taipei)當天所有行事曆(不只 primary)的事件,依開始時間排序。 */
export async function getTodayEvents(config: AppConfig, day: Date = new Date()): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: "v3", auth: buildOAuthClient(config) });

  const dateKey = getTaipeiDateKey(day);
  const startOfDay = new Date(`${dateKey}T00:00:00+08:00`);
  const endOfDay = new Date(`${dateKey}T23:59:59.999+08:00`);

  return listEventsAcrossCalendars(calendar, {
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
  });
}

/** 取得從現在起 withinMinutes 分鐘內、所有行事曆中即將開始的事件。 */
export async function getUpcomingEvents(config: AppConfig, withinMinutes: number): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: "v3", auth: buildOAuthClient(config) });

  const now = new Date();
  const horizon = new Date(now.getTime() + withinMinutes * 60_000);

  const events = await listEventsAcrossCalendars(calendar, {
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
  });

  return events.filter((event) => !event.allDay);
}
