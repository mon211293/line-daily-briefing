import type { Request } from "@google-cloud/functions-framework";
import type { AppConfig } from "./config";

/** 檢查請求是否帶對觸發密碼(header `x-trigger-secret` 或 query `?key=`)。 */
export function isAuthorizedTrigger(req: Request, config: AppConfig): boolean {
  const provided = req.get("x-trigger-secret") ?? req.query.key;
  return typeof provided === "string" && provided === config.triggerSecret;
}
