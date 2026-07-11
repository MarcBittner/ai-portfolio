// scripts/seed-demo.ts — populate the flotilla DB with the SAFE, obviously-fake
// demo fleet (the ai-portfolio roster as the "managed fleet") so the PUBLIC
// read-only showcase renders a realistic dashboard instead of an empty one.
//
// Run (loads secrets from .env.local; Node ≥ 20):
//   npm run seed-demo
//   # equivalently:
//   node --experimental-strip-types --env-file=.env.local scripts/seed-demo.ts
//
// Only env it needs: MONGODB_URI / MONGODB_DB (the flotilla store). No provisioning
// creds, no secrets — everything written is synthetic (see lib/seedDemo.ts).
//
// IDEMPOTENT: re-running converges on the same fleet (keyed on stable demo ids),
// so it's safe to run repeatedly or alongside the boot self-seed.

import { seedDemoFleet } from "../lib/seedDemo.ts";

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set (put it in .env.local). Aborting.");
    process.exit(1);
  }
  const res = await seedDemoFleet();
  console.log(
    `Seeded demo fleet: ${res.instances} instances · ${res.templates} templates · ` +
      `${res.backups} backups · ${res.jobs} jobs · ${res.logs} log lines.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo seed failed:", err);
  process.exit(1);
});
