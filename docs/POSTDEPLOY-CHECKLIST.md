# Post-deploy checklist — ai-portfolio live demos

Every item below is a failure mode that has actually bitten this fleet. Unit tests
do **not** catch these — they test code in isolation, not the running deployment.
Run the live verifier after any (re)deploy or URL change:

```sh
python3 scripts/postdeploy-check.py          # all services
python3 scripts/postdeploy-check.py counsel  # one
```

It hits the live URLs and fails (non-zero) if anything is **DOWN** or has
**FELL-BACK** (routing dropped to the offline fallback). Source of truth for URLs:
`scripts/live-urls.json` — it drives the README links **and** vigil's targets;
keep all three in sync.

## The checklist

| # | Failure mode | Symptom | Check | Fix |
|---|---|---|---|---|
| 1 | **Free-tier suspended** | "This service has been suspended" / HTTP 503 | `postdeploy-check.py` → DOWN | Redeploy onto an account with free hours. System-suspended services **cannot** be resumed via API (only user-suspended can); recreate elsewhere. Spread ~6/account; **don't keep them awake 24/7**. |
| 2 | **Commits not pushed** | Live site / README shows old behavior or old URLs; Render builds a stale commit | `git rev-list --count origin/main..HEAD` > 0 | `GIT_SSH_COMMAND="ssh -i docs/spec/untracked/ghostlocalhost.pem -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git push origin main` |
| 3 | **Wrong Docker build context** | `build_failed`: `COPY src/ … "/src": not found` | Render deploy status = `build_failed` | Every Dockerfile here is **project-dir context**: set `rootDir=projects/<name>` + `dockerfilePath=./Dockerfile` (NOT `rootDir=""` + `./projects/<name>/Dockerfile`). |
| 4 | **Missing `OPENROUTER_API_KEY`** | Routing falls back to offline/mock; `/llm` shows all providers `false` | `postdeploy-check.py` → **FELL-BACK** | Set `OPENROUTER_API_KEY` env var on the service (free-tier key in `credentials.md`); env change auto-redeploys. |
| 5 | **Stale URLs after redeploy** | README / email / vigil link to dead `…onrender.com` | grep for `onrender.com` not in `scripts/live-urls.json` | Update `scripts/live-urls.json`, then re-run the README + vigil patch and **push**. |
| 6 | **vigil shows all nodes down** | Every target red | vigil targets vs `live-urls.json` | vigil targets are seeded in `projects/vigil/src/vigil/config.py` (`_SEED_ROWS`). Update from `live-urls.json`, push, **redeploy vigil**. |
| 7 | **cycleledger down** | `update_failed` / 503 | DOWN | Rails app **needs PostgreSQL**: provision a DB and set `DATABASE_URL`; no offline fallback. |
| 8 | **trueline down** | `build_failed` | DOWN | Next.js + Convex + Clerk: build needs `CONVEX_URL` + Clerk publishable/secret keys as env vars. |
| 9 | **Cold start (not a failure)** | First hit takes ~30–60s | n/a | Free instances sleep after ~15 min idle; the verifier allows a 75s timeout. Reload once. |

## Sustainability rule (why accounts get exhausted)

Free tier ≈ **750 instance-hours/month per account**. A service kept awake 24/7
burns ~744 of them — the whole budget. Accounts 1–3 were exhausted because vigil
polled every demo every 60s, keeping the entire fleet awake. **Do not run a fleet
pinger that keeps services awake.** Idle services sleep and cost almost nothing;
that is what keeps the free tier solvent. vigil only polls while someone has it
open (it sleeps too) — keep it that way.

## Standard redeploy flow

1. Push code: ensure `origin/main` == `HEAD` (item 2).
2. Create/recreate services with the correct `rootDir` (item 3).
3. Set `OPENROUTER_API_KEY` on every LLM service (item 4).
4. Update `scripts/live-urls.json` → patch README + vigil → push (items 5–6).
5. Redeploy vigil so it monitors the new URLs.
6. `python3 scripts/postdeploy-check.py` → must PASS before calling it done.
