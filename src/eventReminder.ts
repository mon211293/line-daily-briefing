import * as functions from "@google-cloud/functions-framework";
import { loadConfig, type AppConfig } from "./config";
import { getUpcomingEvents, type CalendarEvent } from "./calendar";
import { hasBeenNotified, markNotified } from "./reminderStore";
import { pushText } from "./line";
import { isAuthorizedTrigger } from "./httpAuth";

const REMINDER_WINDOW_MINUTES = Number(process.env.REMINDER_WINDOW_MINUTES ?? 60);

function formatReminderText(event: CalendarEvent): string {
  const time = event.start.toLocaleTimeString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const location = event.location ? `\n📍 ${event.location}` : "";
  const description = event.description ? `\n📝 ${event.description}` : "";
  return `⏰ 即將開始:${event.title}\n🕐 ${time}${location}${description}`;
}

export async function eventReminder(config: AppConfig): Promise<void> {
  const events = await getUpcomingEvents(config, REMINDER_WINDOW_MINUTES);

  for (const event of events) {
    if (await hasBeenNotified(event.id)) continue;

    await pushText(config, formatReminderText(event));
    await markNotified(event.id);
  }
}

functions.http("eventReminder", async (req, res) => {
  try {
    const config = await loadConfig();
    if (!isAuthorizedTrigger(req, config)) {
      res.status(401).send("Unauthorized");
      return;
    }

    await eventReminder(config);
    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send(err instanceof Error ? err.message : "Unknown error");
  }
});
