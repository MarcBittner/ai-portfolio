// Durable, REUSABLE login links for the CO-Ver QA Fixture org (production).
// Each GET mints a FRESH single-use Clerk sign-in ticket and 302s into the app,
// so the SAME url works over and over. Path = role, e.g. /owner /gc /approver.
const http = require("http")
const https = require("https")
const SK = process.env.CLERK_SECRET_KEY
const ROLES = JSON.parse(process.env.ROLES_JSON || "{}")
const APP = process.env.APP_BASE_URL || "https://app.co-ver.com"

http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/"
  if (path === "/health") { res.writeHead(200); return res.end("ok") }
  const role = path.slice(1)
  const uid = ROLES[role]
  if (!uid) {
    const links = Object.keys(ROLES).sort().map(r => `<li><a href="/${r}">${r}</a></li>`).join("")
    res.writeHead(200, { "Content-Type": "text/html" })
    return res.end(`<h2>CO-Ver QA login</h2><p>Reusable — each click mints a fresh ticket.</p><ul>${links}</ul>`)
  }
  const body = JSON.stringify({ user_id: uid, expires_in_seconds: 600 })
  const r = https.request("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: { Authorization: "Bearer " + SK, "Content-Type": "application/json",
      "User-Agent": "co-ver-qa-login/1.0", "Content-Length": Buffer.byteLength(body) },
  }, (resp) => {
    let d = ""
    resp.on("data", c => (d += c))
    resp.on("end", () => {
      try {
        const t = JSON.parse(d).token
        if (!t) throw new Error(d)
        res.writeHead(302, { Location: APP + "/sign-in?__clerk_ticket=" + t })
        res.end()
      } catch (e) { res.writeHead(500); res.end("mint failed: " + d) }
    })
  })
  r.on("error", e => { res.writeHead(500); res.end("err " + e.message) })
  r.write(body); r.end()
}).listen(process.env.PORT || 10000, () => console.log("qafix-login up"))
