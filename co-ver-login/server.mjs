/**
 * CO-Ver durable login redirect.
 *
 * WHY IT EXISTS. The CO-Ver preview/staging Clerk instance
 * (stirred-leech-68) has NO password first factor — a live read of
 * /v1/environment returns first_factors: [] for password, and only
 * email_code / email_link / passkey are usable. So there is no email +
 * password login to hand anybody. Clerk sign-in TICKETS do work
 * (/sign-in?__clerk_ticket=...) but they are SINGLE USE, so a ticket pasted
 * into a doc is dead the moment one person clicks it.
 *
 * This service turns a single-use ticket into a DURABLE LINK: a permanent URL
 * that mints a FRESH ticket on every visit and 302s you into the app already
 * signed in. Bookmark it, share it, click it a hundred times.
 *
 * NO SECRET IS EVER IN THIS REPO. CLERK_SECRET_KEY and the user ids are Render
 * environment variables (sync:false). This repo is PUBLIC.
 */
import http from "node:http";

const {
  CLERK_SECRET_KEY,
  TARGET_URL,
  USERS = "",
  PORT = 10000,
} = process.env;

// USERS is "slug=user_xxx,slug2=user_yyy" — no names or emails in code.
const DIRECTORY = Object.fromEntries(
  USERS.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }),
);

async function mintTicket(userId) {
  const r = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    // Short-lived ON PURPOSE. The LINK is durable, the ticket is not: a fresh
    // one is minted per visit, so a ticket that leaks out of a browser history
    // is worthless within the hour.
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 3600 }),
  });
  if (!r.ok) throw new Error(`clerk ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).token;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const slug = url.pathname.replace(/^\/+|\/+$/g, "");

    if (slug === "healthz" || slug === "") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, who: Object.keys(DIRECTORY) }));
    }

    const userId = DIRECTORY[slug];
    if (!userId) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(`no such login: ${slug}\n`);
    }

    // ?to= lets one service serve any preview without a redeploy; it must be a
    // co-ver host, so this cannot be turned into an open redirect that carries
    // a live session ticket to somebody else's domain.
    const requested = url.searchParams.get("to");
    let target = TARGET_URL;
    if (requested) {
      try {
        const u = new URL(requested);
        if (u.protocol === "https:" && /(^|[.-])co-ver[.-]|co-ver\.com$/.test(u.hostname)) {
          target = u.origin;
        }
      } catch {
        /* fall through to TARGET_URL */
      }
    }

    try {
      const ticket = await mintTicket(userId);
      res.writeHead(302, {
        location: `${target}/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`,
        "cache-control": "no-store",
      });
      res.end();
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`could not mint a sign-in ticket: ${String(e).slice(0, 300)}\n`);
    }
  })
  .listen(Number(PORT), () => console.log(`co-ver-login on :${PORT}`));
