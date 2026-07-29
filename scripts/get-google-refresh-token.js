// 一次性腳本:取得可長期存取你 Google Calendar 的 refresh_token。
// 用法: node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>
//
// 前置:在 Google Cloud Console > API 和服務 > 憑證,建立一組
// 「桌面應用程式 (Desktop app)」類型的 OAuth 用戶端 ID,取得 client_id / client_secret。
const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");

const [, , clientId, clientSecret] = process.argv;
if (!clientId || !clientSecret) {
  console.error("用法: node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const REDIRECT_URI = "http://127.0.0.1:3000/oauth2callback";
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // 強制回傳 refresh_token,即使先前已授權過
  scope: ["https://www.googleapis.com/auth/calendar.readonly"],
});

console.log("\n請在瀏覽器打開以下網址並登入你要讀取行事曆的 Google 帳號:\n");
console.log(authUrl, "\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get("code");
  res.end("授權完成,可以關閉此分頁,回到終端機查看 refresh_token。");
  server.close();

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.error("\n沒有取得 refresh_token,請確認是否已先前授權過此應用程式(可到 https://myaccount.google.com/permissions 移除後重試)。");
    process.exit(1);
  }

  console.log("\n=== 請把下面這行存入 Secret Manager 的 GOOGLE_OAUTH_REFRESH_TOKEN ===\n");
  console.log(tokens.refresh_token);
  console.log("");
  process.exit(0);
});

server.listen(3000);
