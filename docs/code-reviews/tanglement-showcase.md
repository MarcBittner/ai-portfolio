# Code Review — tanglement-showcase

> **Remediation status — review-only (not auto-modified).**
> Reason: pitch deck + demo-site; no backend test suite. Findings below are documented for manual remediation; no code changes were applied so safety could not be proven here.


**Health:** fair — functional demo-site with a working waitlist flow; the `git-encrypt` tool uses critically weak cryptography, and the rate-limiting infrastructure is defined but never wired into the route it was written for.

---

## Findings Table

| # | Severity | Category | File | Finding | Recommendation | UX Impact | Auto-fixable |
|---|----------|----------|------|---------|----------------|-----------|--------------|
| 1 | high | security | `src/app/api/waitlist/route.ts` | No rate limiting on POST /api/waitlist. `checkRateLimit` exists in `src/lib/api.ts` but is never called in this route. Unlimited requests can fill the DB and trigger unlimited outbound emails. | Import and call `checkRateLimit(request)` at the top of the POST handler; return 429 on rejection. | false | true |
| 2 | high | security | `code/git-encrypt/main.go:300-318,171-192` | `encryptFileHybrid` and `encryptWithECDSA` both use XOR with key material instead of real AES. XOR provides no semantic security and no integrity. The "hybrid" label is misleading. | Replace XOR with `crypto/aes` + `crypto/cipher` (AES-256-GCM). Use the RSA/ECDH shared secret only to wrap the AES key. | false | false |
| 3 | high | security | `scripts/setup-deployment.sh:118-134` | `download_files()` fetches scripts from a raw GitHub URL and marks them executable without any checksum or signature verification. A compromised upstream or a MitM can achieve RCE on the host. | Pin to a specific commit SHA in the URL and verify a SHA-256 checksum (stored out-of-band) before executing. | false | false |
| 4 | medium | security | `code/git-encrypt/main.go:286-297` | RSA-OAEP with a 2048-bit key can encrypt at most ~190 bytes. When the direct encryption call fails (any file larger than that), the code silently falls through to `encryptFileHybrid`, which uses XOR. The user sees no warning. | Add an explicit check: if `len(plaintext) > maxRSAPayload`, go directly to hybrid. Log clearly which path was taken. | false | true |
| 5 | medium | security | `src/app/api/waitlist/route.ts:125-146` | GET /api/waitlist is unauthenticated and returns `totalSignups`. This exposes business-sensitive data to any caller. | Remove the signup count from the unauthenticated response, or require a secret header / admin auth. | false | true |
| 6 | medium | security | `src/lib/api.ts:93-101` | `getClientIp` trusts `X-Forwarded-For` unconditionally. An attacker controlling the header can present any IP to bypass the rate limiter. | Only read `X-Forwarded-For` when running behind a known proxy. In Next.js App Router, prefer `request.ip` or the rightmost non-private IP. | false | true |
| 7 | medium | security | `src/hooks/useTextReveal.tsx:25,31` | `element.innerHTML` is set by joining characters from `element.textContent`. `textContent` decodes HTML entities, so text containing `<` or `>` would be injected as tags. Currently safe with static strings, but the pattern will silently XSS if description is ever made dynamic. | Build DOM nodes with `document.createElement('span')` and `node.textContent = char` instead of template-literal innerHTML. | true | true |
| 8 | medium | bug | `src/lib/api.ts:108-151` | The `RateLimiter` is an in-process `Map` singleton. In serverless / multi-instance deployments each cold-start gets a fresh map, making rate limiting effectively a no-op across instances. | Replace with a Redis-backed counter (e.g. `@upstash/ratelimit`) or use Vercel/Next.js edge middleware rate limiting. | false | false |
| 9 | medium | bug | `scripts/deploy-poll.sh:163-167` | The "rollback" on a failed deployment just calls `docker-compose up -d` again with the same failing image. No previous image is saved or restored. | Before pulling, capture the current image digest (`docker inspect`). On failure, tag and start from the saved digest. | true | true |
| 10 | medium | quality | `src/lib/env.ts:75` | On validation failure `validateEnv` returns `{} as z.infer<typeof envSchema>`. This lies to TypeScript: at runtime every env var will be `undefined`. The production code path also only logs a warning instead of failing hard. | Return `parsed.data` when valid; in production (`isProduction && !SKIP_ENV_VALIDATION`) throw on missing required vars. | false | true |
| 11 | low | bug | `src/app/api/waitlist/route.ts:74-85` and `src/lib/email/convertkit.ts:63-72` | When ConvertKit is not configured, `subscribeToWaitlist` returns `{ success: true, data: { id: 0 } }`. The route then writes `convertKitSubscriberId: "0"` to the DB — a sentinel value that is indistinguishable from a real subscriber ID. | Guard: only update `convertKitSubscriberId` when `result.data.id && result.data.id !== 0`. | false | true |
| 12 | low | security | `src/app/api/waitlist/route.ts:16-19` | The `source` field is `z.string().optional()` with no `max()`. The `referrer` from the HTTP header is also stored without length capping. Both reach the DB with no upper bound. | Add `.max(255)` (or similar) to the Zod schema for `source`; slice `referrer` to a safe length before storing. | false | true |
| 13 | low | quality | `src/lib/email/sendgrid.ts:161-215` | `sendEmailVerification` is fully implemented but has no caller in the codebase. | Either wire it up to an email-verification flow or remove it until needed. | false | true |
| 14 | low | quality | `src/lib/email/convertkit.ts:121-260` | `tagSubscriber`, `updateSubscriberFields`, and `getSubscriber` on `ConvertKitClient` are never called from application code. | Remove until the email-marketing flow actually needs them, to reduce the dead-code surface. | false | true |
| 15 | low | quality | `src/lib/api.ts:167-181` and `src/app/api/waitlist/route.ts` | `checkRateLimit` is exported and documented with a usage example, but no route imports or calls it. | Apply it (finding #1) or add a note that it is intentionally unused pending Redis integration. | false | true |
| 16 | low | quality | `src/lib/api.ts:9-21` and `src/types/api.ts:31-43` | `ApiSuccessResponse` and `ApiErrorResponse` are defined identically in both files. | Keep the canonical definition in `src/types/api.ts` and import from there in `src/lib/api.ts`. | false | true |
| 17 | low | quality | `src/components/sections/NetworkStatus.tsx:231` | Metric cards in the dynamic list use `key={index}` instead of a stable key. If the list order ever changes, React will reuse the wrong DOM nodes. | Use `key={metric.label}` (labels are unique in the current data). | false | true |

---

## Notes

### git-encrypt crypto concerns (findings #2, #4)
The tool is conceptually interesting, but the crypto implementation is non-standard in ways that undermine its purpose. ECDSA keys are not designed for encryption; the ECDH-derived shared secret is then used as a repeating XOR pad, which is essentially a Vigenère cipher. For files where RSA direct encryption fails (i.e., almost everything), the same XOR applies. A reviewer who received two ciphertexts encrypted with the same key could XOR them to cancel the key entirely. Replace with proper AES-256-GCM authenticated encryption.

### Rate limiting (findings #1, #6, #8)
The scaffolding for rate limiting is well-designed (`RateLimiter`, `checkRateLimit`, IP extraction) but sits entirely unused in the only route that needs it. The comment in `api.ts` already acknowledges Redis is needed for production; the immediate fix is to at least wire in the in-memory limiter for single-instance use.

### Environment validation (finding #10)
The `SKIP_ENV_VALIDATION` escape hatch is intentional for CI, but the production branch should still fail fast on genuinely missing vars (DATABASE_URL, SENDGRID_API_KEY). The current logic only logs a warning, meaning a misconfigured deploy silently starts with `undefined` values and fails at the first DB call.

### Dead code (findings #13–#16)
There is more stub/scaffold code than live code for several features (email verification, ConvertKit tagging, form components). This is normal for an early-stage demo site, but it creates maintenance debt; each dead branch needs to be re-examined every time the live code around it changes.
