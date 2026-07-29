import * as functions from "@google-cloud/functions-framework";
import { loadConfig, type AppConfig } from "./config";
import { getTodayEvents, type CalendarEvent } from "./calendar";
import { pushText } from "./line";
import { isAuthorizedTrigger } from "./httpAuth";

const TAIPEI_TIME_ZONE = "Asia/Taipei";

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString("zh-TW", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function formatEventLine(event: CalendarEvent): string {
  const header = event.allDay
    ? `・${event.title}(全天)`
    : `・${event.start.toLocaleTimeString("zh-TW", {
        timeZone: TAIPEI_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })} ${event.title}`;

  const detailLines: string[] = [];
  if (event.location) detailLines.push(`    📍 ${event.location}`);
  if (event.description) detailLines.push(`    📝 ${event.description}`);

  return [header, ...detailLines].join("\n");
}

function buildTextSummary(dateLabel: string, events: CalendarEvent[]): string {
  const lines = [`📅 ${dateLabel}`, ""];

  if (events.length === 0) {
    lines.push("今日沒有行程");
  } else {
    lines.push("【今日行事曆】", "");
    lines.push(events.map(formatEventLine).join("\n\n"));
  }

  return lines.join("\n");
}

export async function dailyBriefing(config: AppConfig): Promise<void> {
  const now = new Date();
  const dateLabel = formatDateLabel(now);

  const events = await getTodayEvents(config, now);

  const text = buildTextSummary(dateLabel, events);
  await pushText(config, text);
}

functions.http("dailyBriefing", async (req, res) => {
  try {
    const config = await loadConfig();
    if (!isAuthorizedTrigger(req, config)) {
      res.status(401).send("Unauthorized");
      return;
    }

    await dailyBriefing(config);
    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send(err instanceof Error ? err.message : "Unknown error");
  }
});
