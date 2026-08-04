# LINE 官方帳號:每日行事曆推播

每天自動推播:今日所有行事曆事件,以及即將開始(1 小時左右)的活動提醒,純文字訊息發送到 LINE(個人或群組皆可)。

## 架構

```
GitHub Actions (cron) ──(每天 07:00, Asia/Taipei)──▶ Cloud Function: dailyBriefing
GitHub Actions (cron) ──(每小時整點)───────────────▶ Cloud Function: eventReminder
```

- `dailyBriefing`:讀 Google Calendar 當日所有行事曆(不只 primary,包含所有出現在行事曆清單裡的行事曆)的事件 → LINE 推播純文字摘要,行程之間留空行方便閱讀,有地點/備注的行程會附上 📍/📝
- `eventReminder`:讀「即將開始的事件」(所有行事曆)→ LINE 推播文字提醒(用 Firestore 記錄已提醒過的事件,避免重複)。時間窗用 `REMINDER_WINDOW_MINUTES` 環境變數控制,預設 **75 分鐘**(比整點掃描的間隔多留一點餘裕,避免行程剛好卡在整點掃描的邊界被漏掉)

**觸發方式是 GitHub Actions,不是 Cloud Scheduler。** 原本用 Cloud Scheduler,但改用 GitHub Actions 是因為一度誤以為 Scheduler 費用有問題(後來沒有實際查證,Scheduler 兩個工作其實在免費額度內)。實測發現 **GitHub Actions 的 cron 對高頻率排程(例如原本用的每 15 分鐘)非常不可靠**——會被跳過、間隔可能拉長到 2~4 小時,所以提醒功能改成每小時整點掃描一次,搭配較寬的時間窗降低漏掉的機率。如果之後想追求更精準的提醒時機,可以考慮換回 Cloud Scheduler(見文末)。

因為 GitHub Actions 沒辦法做 Google OIDC 驗證,兩個 Cloud Function 部署成 `--allow-unauthenticated`(網址公開),改成程式碼內建一組共用密碼(`TRIGGER_SECRET`)保護:請求要帶 `x-trigger-secret` header 或 `?key=` 參數對上,否則回 401。

推播目標(`LINE_TARGET_USER_ID` 這組 Secret)可以是個人 userId,也可以是群組 groupId——LINE 的 push API 對兩者用法完全相同。若要推到群組,注意 **LINE 平台限制一個群組最多只能有一個官方帳號**,而且該官方帳號要先在 LINE Developers Console →「Messaging API」分頁把「Allow bot to join group chats」打開,才能被邀請進群組。

## 前置準備

- 已安裝並登入 `gcloud` CLI,且有一個已啟用帳單的 GCP 專案
- 已申請好 LINE Official Account,並取得 Messaging API 的 Channel Access Token / Channel Secret
- 一個 GitHub 帳號(裝 `gh` CLI 並登入),用來跑排程用的 Actions
- Node.js 20+

```bash
export GCP_PROJECT_ID="你的-gcp-project-id"
export REGION="asia-east1"
gcloud config set project "$GCP_PROJECT_ID"

gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
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
printf '%s' "$(openssl rand -hex 32)"     | gcloud secrets create TRIGGER_SECRET --data-file=-
```

Cloud Functions 執行時的服務帳號需要 `roles/secretmanager.secretAccessor`。找出執行服務帳號(預設是 `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`)並授權:

```bash
export RUNTIME_SA="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

for secret in LINE_CHANNEL_ACCESS_TOKEN LINE_CHANNEL_SECRET LINE_TARGET_USER_ID \
              GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REFRESH_TOKEN \
              TRIGGER_SECRET; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
done

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/datastore.user
```

> 之後要換推播對象(例如從個人改成群組),不用重新部署——直接 `printf '%s' "<新的ID>" | gcloud secrets versions add LINE_TARGET_USER_ID --data-file=-` 加一個新版本,程式碼永遠讀最新版本,沒有做跨 invocation 快取。

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

兩個 function 都部署成公開網址,靠程式碼裡的 `TRIGGER_SECRET` 檢查擋掉未授權請求:

```bash
gcloud functions deploy dailyBriefing \
  --gen2 --runtime=nodejs20 --region="$REGION" --source=. \
  --entry-point=dailyBriefing --trigger-http --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${GCP_PROJECT_ID}"

gcloud functions deploy eventReminder \
  --gen2 --runtime=nodejs20 --region="$REGION" --source=. \
  --entry-point=eventReminder --trigger-http --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${GCP_PROJECT_ID}"
```

## 建立排程(GitHub Actions)

1. 把這個 repo push 到 GitHub(建議 **公開 repo**——公開 repo 的 Actions 分鐘數完全免費不設上限;私有 repo 每月只有 2000 分鐘免費,以每小時觸發的頻率通常夠用,但如果之後又想拉高頻率就可能超額)
2. 在 repo 設定一個 Secret:
   ```bash
   gh secret set TRIGGER_SECRET --body "<跟 GCP Secret Manager 裡 TRIGGER_SECRET 一樣的值>"
   ```
3. `.github/workflows/schedule.yml` 已經寫好兩個 cron(`0 23 * * *` 對應台北 07:00 每日推播,`0 * * * *` 每小時整點提醒檢查),把裡面的 Cloud Run URL 換成你自己的兩個函式網址
4. 手動測試:
   ```bash
   gh workflow run schedule.yml
   gh run list --limit 3
   ```

> 如果想追求提醒的精準時機(例如真的要 15 分鐘級別的頻率),GitHub Actions 的 cron 不適合——可以改回 Cloud Scheduler(`gcloud scheduler jobs create http ...`,搭配 `--oidc-service-account-email` 走 Google 身分驗證,或沿用現在的 `TRIGGER_SECRET` 方式,把 `--headers="x-trigger-secret=..."` 帶給 Scheduler 的 HTTP target)。Cloud Scheduler 每月前 3 個工作免費,精準度遠優於 GitHub Actions。

## 驗證

```bash
# 直接 curl 觸發,確認 LINE 有收到文字訊息
curl -X POST "<dailyBriefing 網址>" -H "x-trigger-secret: <TRIGGER_SECRET>"
curl -X POST "<eventReminder 網址>" -H "x-trigger-secret: <TRIGGER_SECRET>"

gcloud functions logs read dailyBriefing --region="$REGION" --gen2 --limit=50
gcloud functions logs read eventReminder --region="$REGION" --gen2 --limit=50

# 或直接看 GitHub Actions 執行紀錄
gh run list --limit 10
```

## 補充

- `reminded-events`(Firestore)只用來去重,沒有自動清理;若想省空間,可在該 collection 的 `expireAt` 欄位上設定 [TTL 政策](https://cloud.google.com/firestore/docs/ttl)。
- 若之後想調整提醒時間窗,部署時加上 `--set-env-vars=...,REMINDER_WINDOW_MINUTES=<分鐘數>`;調整時記得跟 GitHub Actions 的掃描頻率一起考慮(窗口要略大於掃描間隔,避免邊界漏抓)。
- **臨時新增的行程,如果距離開始時間不到一次掃描間隔(目前是 1 小時),可能來不及被提醒到**——這是低頻率掃描的固有限制,不是 bug。
