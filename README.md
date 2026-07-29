# LINE 官方帳號:每日行事曆推播

每天自動推播:今日所有行事曆事件,以及即將開始(1 小時內)的活動提醒,純文字訊息發送到 LINE(個人或群組皆可)。

## 架構

```
Cloud Scheduler ──(每天 07:00, Asia/Taipei)──▶ Cloud Function: dailyBriefing
Cloud Scheduler ──(每 15 分鐘)───────────────▶ Cloud Function: eventReminder
```

- `dailyBriefing`:讀 Google Calendar 當日所有行事曆(不只 primary,包含所有「有勾選顯示」的行事曆)的事件 → LINE 推播純文字摘要
- `eventReminder`:讀「1 小時內即將開始」的事件(所有行事曆)→ LINE 推播文字提醒(用 Firestore 記錄已提醒過的事件,避免重複;時間窗可用 `REMINDER_WINDOW_MINUTES` 環境變數調整,預設 60)

推播目標(`LINE_TARGET_USER_ID` 這組 Secret)可以是個人 userId,也可以換成群組 groupId——LINE 的 push API 對兩者用法完全相同。若要推到群組,注意 **LINE 平台限制一個群組最多只能有一個官方帳號**,而且該官方帳號要先在 LINE Developers Console →「Messaging API」分頁把「Allow bot to join group chats」打開,才能被邀請進群組。

## 前置準備

- 已安裝並登入 `gcloud` CLI,且有一個已啟用帳單的 GCP 專案
- 已申請好 LINE Official Account,並取得 Messaging API 的 Channel Access Token / Channel Secret
- Node.js 20+

```bash
export GCP_PROJECT_ID="你的-gcp-project-id"
export REGION="asia-east1"
gcloud config set project "$GCP_PROJECT_ID"

gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com
```

## 一次性設定

### 1. 建立 Firestore(Native mode,供 eventReminder 記錄已提醒事件)

```bash
gcloud firestore databases create --location="$REGION"
```

### 2. 取得 Google Calendar OAuth refresh token

1. 到 [Google Cloud Console → API 和服務 → 憑證](https://console.cloud.google.com/apis/credentials),建立一組 **OAuth 用戶端 ID**,類型選 **桌面應用程式**,取得 `client_id` / `client_secret`
2. 在專案根目錄執行:
   ```bash
   node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>
   ```
3. 依終端機指示,在瀏覽器打開連結並用「你要讀取行事曆的那個 Google 帳號」登入、同意授權
4. 終端機會印出 `refresh_token`,留著下一步使用

### 3. 取得推播目標的 LINE ID(個人 userId 或群組 groupId)

`getFollowerIds` 這個 LINE API 對不少帳號方案是被鎖住的(回傳 `Access to this API is not available for your account`),不一定能用。比較可靠的方式:

1. 到 [webhook.site](https://webhook.site) 拿一個專屬網址
2. 到 LINE Developers Console → 你的 channel →「Messaging API」分頁,把 Webhook URL 暫時設成這個網址,並打開「Use webhook」
3. 私訊這個官方帳號(取得你自己的 userId),或是把它加進一個群組後在群組裡傳訊息(取得 groupId)
4. 回 webhook.site 看收到的請求內容,`source` 欄位裡:
   - 私訊會有 `"type": "user", "userId": "U..."`
   - 群組訊息會有 `"type": "group", "groupId": "C..."`
5. 測完記得把 Webhook URL 清掉、「Use webhook」關閉(推播用不到 webhook)

### 4. 把憑證存進 Secret Manager

```bash
printf '%s' "<CHANNEL_ACCESS_TOKEN>"      | gcloud secrets create LINE_CHANNEL_ACCESS_TOKEN --data-file=-
printf '%s' "<CHANNEL_SECRET>"            | gcloud secrets create LINE_CHANNEL_SECRET --data-file=-
printf '%s' "<USER_ID_或_GROUP_ID>"       | gcloud secrets create LINE_TARGET_USER_ID --data-file=-
printf '%s' "<GOOGLE_CLIENT_ID>"          | gcloud secrets create GOOGLE_OAUTH_CLIENT_ID --data-file=-
printf '%s' "<GOOGLE_CLIENT_SECRET>"      | gcloud secrets create GOOGLE_OAUTH_CLIENT_SECRET --data-file=-
printf '%s' "<GOOGLE_REFRESH_TOKEN>"      | gcloud secrets create GOOGLE_OAUTH_REFRESH_TOKEN --data-file=-
```

Cloud Functions 執行時的服務帳號需要 `roles/secretmanager.secretAccessor`。找出執行服務帳號(預設是 `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`)並授權:

```bash
export RUNTIME_SA="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

for secret in LINE_CHANNEL_ACCESS_TOKEN LINE_CHANNEL_SECRET LINE_TARGET_USER_ID \
              GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REFRESH_TOKEN; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
done

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/datastore.user
```

> 之後要換推播對象(例如從個人改成群組),不用重新部署——直接 `printf '%s' "<新的ID>" | gcloud secrets versions add LINE_TARGET_USER_ID --data-file=-` 加一個新版本,程式碼永遠讀最新版本。

## 本地開發

```bash
npm install

# 需要上面設定好的環境變數 + gcloud 登入身分(ADC)才能真的打通 API
export GCP_PROJECT_ID="你的-gcp-project-id"
gcloud auth application-default login

npm run start:daily     # http://localhost:8080,curl 觸發測試 dailyBriefing
npm run start:reminder  # eventReminder
```

## 部署

```bash
gcloud functions deploy dailyBriefing \
  --gen2 --runtime=nodejs20 --region="$REGION" --source=. \
  --entry-point=dailyBriefing --trigger-http --no-allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${GCP_PROJECT_ID}"

gcloud functions deploy eventReminder \
  --gen2 --runtime=nodejs20 --region="$REGION" --source=. \
  --entry-point=eventReminder --trigger-http --no-allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${GCP_PROJECT_ID}"
```

## 建立排程(Cloud Scheduler)

兩個 function 都設定 `--no-allow-unauthenticated`,所以 Scheduler 要用一個有 `roles/run.invoker` 的服務帳號,以 OIDC 身分呼叫:

```bash
gcloud iam service-accounts create line-briefing-scheduler \
  --display-name="LINE Briefing Scheduler Invoker"
export SCHEDULER_SA="line-briefing-scheduler@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

export DAILY_URL="$(gcloud functions describe dailyBriefing --gen2 --region="$REGION" --format='value(serviceConfig.uri)')"
export REMINDER_URL="$(gcloud functions describe eventReminder --gen2 --region="$REGION" --format='value(serviceConfig.uri)')"

gcloud run services add-iam-policy-binding dailybriefing --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" --role=roles/run.invoker
gcloud run services add-iam-policy-binding eventreminder --region="$REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" --role=roles/run.invoker

gcloud scheduler jobs create http daily-briefing-job \
  --location="$REGION" --schedule="0 7 * * *" --time-zone="Asia/Taipei" \
  --uri="$DAILY_URL" --http-method=POST \
  --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$DAILY_URL"

gcloud scheduler jobs create http event-reminder-job \
  --location="$REGION" --schedule="*/15 * * * *" --time-zone="Asia/Taipei" \
  --uri="$REMINDER_URL" --http-method=POST \
  --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$REMINDER_URL"
```

> 注意:`gcloud run services ...` 要用小寫的 Cloud Run 服務名稱(`dailybriefing` / `eventreminder`),跟 Cloud Functions 顯示的大小寫名稱不同。

## 驗證

```bash
# 手動觸發一次,確認 LINE 有收到文字訊息
gcloud scheduler jobs run daily-briefing-job --location="$REGION"
gcloud functions logs read dailyBriefing --region="$REGION" --gen2 --limit=50

gcloud scheduler jobs run event-reminder-job --location="$REGION"
gcloud functions logs read eventReminder --region="$REGION" --gen2 --limit=50
```

## 補充

- `reminded-events`(Firestore)只用來去重,沒有自動清理;若想省空間,可在該 collection 的 `expireAt` 欄位上設定 [TTL 政策](https://cloud.google.com/firestore/docs/ttl)。
- 若之後想調整提醒時間窗(預設事件開始前 60 分鐘),部署時加上 `--set-env-vars=...,REMINDER_WINDOW_MINUTES=30`。
