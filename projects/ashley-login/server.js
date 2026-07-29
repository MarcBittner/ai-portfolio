// Durable, reusable login link for the CO-Ver GC demo user.
// Each GET mints a FRESH single-use Clerk sign-in ticket and 302s into the app,
// so the SAME url works over and over (until this service or the Clerk key dies).
const http = require("http")
const https = require("https")
const SK = process.env.CLERK_SECRET_KEY
const CUID = process.env.CLERK_USER_ID
const APP = process.env.APP_BASE_URL || "https://app.staging.co-ver.com"

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      return res.end("ok")
    }
    const body = JSON.stringify({ user_id: CUID, expires_in_seconds: 600 })
    const r = https.request(
      "https://api.clerk.com/v1/sign_in_tokens",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + SK,
          "Content-Type": "application/json",
          "User-Agent": "co-ver-login/1.0",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (resp) => {
        let d = ""
        resp.on("data", (c) => (d += c))
        resp.on("end", () => {
          try {
            const t = JSON.parse(d).token
            if (!t) throw new Error(d)
            res.writeHead(302, {
              Location: APP + "/sign-in?__clerk_ticket=" + t,
            })
            res.end()
          } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain" })
            res.end("mint failed: " + d)
          }
        })
      },
    )
    r.on("error", (e) => {
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end("err " + e.message)
    })
    r.write(body)
    r.end()
  })
  .listen(process.env.PORT || 10000, () => console.log("ashley-login up"))
