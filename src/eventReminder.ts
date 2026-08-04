import * as functions from "@google-cloud/functions-framework";
import { loadConfig, type AppConfig } from "./config";
import { getUpcomingEvents, type CalendarEvent } from "./calendar";
import { hasBeenNotified, markNotified } from "./reminderStore";
import { pushText } from "./line";
import { isAuthorizedTrigger } from "./httpAuth";

// 觸發來源改成每小時整點掃描一次(GitHub Actions 對 15 分鐘級的高頻排程不可靠,見 workflow 註解),
// 視窗比掃描間隔多留一些餘裕(75 分鐘 > 60 分鐘),避免行程剛好卡在整點掃描的邊界被漏掉。
const REMINDER_WINDOW_MINUTES = Number(process.env.REMINDER_WINDOW_MINUTES ?? 75);

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
