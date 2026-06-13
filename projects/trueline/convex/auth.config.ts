// Tell Convex to trust JWTs minted by your Clerk instance. Clerk's one-click
// "Convex" JWT template issues tokens with this issuer; Convex validates them
// and exposes the claims via `ctx.auth.getUserIdentity()` inside functions.
//
// CLERK_JWT_ISSUER_DOMAIN is your Clerk Frontend API URL, e.g.
//   https://your-slug.clerk.accounts.dev
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};
