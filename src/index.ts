// Cloud Functions 進入點會用同一份 source 部署兩個函式(--entry-point 決定實際服務哪一個),
// 因此這裡把兩個 functions.http(...) 註冊都載入,GCF 執行時依 FUNCTION_TARGET 選擇對應的一個。
import "./dailyBriefing";
import "./eventReminder";
