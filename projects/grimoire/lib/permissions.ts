// RBAC core — the effective-permission resolver. PURE logic, no Convex/Clerk
// runtime deps, so it's unit-testable in isolation and reusable from any Convex
// function.
//
// Two surfaces:
//   canAccess(...)  — read/edit/admin on a *resource* (space/folder/doc), via grants
//                     + space default; Super short-circuits, deny > allow at any depth.
//   canGlobal(...)  — org-level actions (assign Admin, org config, manage perms, …),
//                     decided purely by role per the §6 boundary table.

// `guest` is the self-signup tier: ranked BELOW `read` for org-level capabilities
// (a guest cannot satisfy a `role:read` grant, so they get no baseline edit/admin
// on curated spaces), yet their per-user owner `admin` grant on their own personal
// `~` space still gives them full control of their own docs. Curated public spaces
// are reachable purely through each space's `defaultRole: "read"` — which applies
// to EVERY signed-in principal regardless of role, guests included.
export type Role = "guest" | "read" | "editor" | "admin" | "super";
export type Capability = "read" | "edit" | "admin";
export type Effect = "allow" | "deny";
export type ResourceType = "space" | "folder" | "doc";

export interface Grant {
  subjectType: "role" | "group" | "user";
  subjectId: string; // role literal | group key | user email
  resourceType: ResourceType;
  resourcePath: string; // space key | folder prefix | exact doc path
  capability: Capability;
  effect: Effect;
}

export interface Principal {
  email: string;
  role: Role;
  groupKeys: string[];
}

export interface ResourceRef {
  type: ResourceType;
  path: string; // doc path, folder prefix, or space key
  spaceKey: string; // owning space — for ancestry + default policy
}

export interface SpacePolicy {
  defaultRole: "read" | "none"; // baseline read for everyone in the space
}

export interface Decision {
  allowed: boolean;
  reason: string;
  grant?: Grant; // the deciding grant, when one applied (explainability)
}

const ROLE_RANK: Record<Role, number> = { guest: 0, read: 1, editor: 2, admin: 3, super: 4 };
const CAP_RANK: Record<Capability, number> = { read: 1, edit: 2, admin: 3 };

/** A grant's capability covers the requested one iff it's at least as strong. */
function covers(granted: Capability, requested: Capability): boolean {
  return CAP_RANK[granted] >= CAP_RANK[requested];
}

/** Does this grant's subject apply to the principal? Role grants are additive:
 *  a `role:read` grant applies to everyone read-or-above (so "all users can read"
 *  is expressible), `role:editor` to editor-or-above, etc. */
function subjectMatches(p: Principal, g: Grant): boolean {
  switch (g.subjectType) {
    case "user":
      return p.email.toLowerCase() === g.subjectId.toLowerCase();
    case "group":
      return p.groupKeys.includes(g.subjectId);
    case "role":
      return ROLE_RANK[p.role] >= ROLE_RANK[(g.subjectId as Role) ?? "super"];
  }
}

/** Does this grant's resource cover the target resource (self or an ancestor)? */
function resourceMatches(r: ResourceRef, g: Grant): boolean {
  if (g.resourceType === "space") return g.resourcePath === r.spaceKey;
  if (g.resourceType === "doc") return r.type === "doc" && g.resourcePath === r.path;
  // folder: prefix match on a path-segment boundary (so "a/b" ⊅ "a/bc").
  const base = g.resourcePath.replace(/\/+$/, "");
  return r.path === base || r.path.startsWith(base + "/");
}

/** Specificity for picking the most relevant grant to cite in `reason`. */
function specificity(g: Grant): number {
  if (g.resourceType === "doc") return 1000 + g.resourcePath.length;
  if (g.resourceType === "folder") return 100 + g.resourcePath.length;
  return 1; // space
}

function mostSpecific(grants: Grant[]): Grant {
  return grants.reduce((a, b) => (specificity(b) > specificity(a) ? b : a));
}

/**
 * Resolve read/edit/admin on a resource. Order (permissions.md §4):
 *   1. Super → allow everything.
 *   2. Collect grants matching {role, groups, self} × {resource ∪ ancestors}.
 *   3. Deny wins — any matching deny at ≥ the requested capability → deny.
 *   4. Allow — any matching allow at ≥ the requested capability → allow.
 *   5. Space default (read only) → allow; else deny.
 * (Admin is NOT a resource short-circuit: per the §6 matrix, Admins edit within
 *  granted scope like Editors — their extra power is global, see canGlobal.)
 */
export function canAccess(
  principal: Principal,
  resource: ResourceRef,
  capability: Capability,
  grants: Grant[],
  spacePolicy: SpacePolicy,
): Decision {
  if (principal.role === "super") {
    return { allowed: true, reason: "super admin" };
  }

  const matching = grants.filter(
    (g) => subjectMatches(principal, g) && resourceMatches(resource, g),
  );

  const denies = matching.filter(
    (g) => g.effect === "deny" && covers(g.capability, capability),
  );
  if (denies.length) {
    const g = mostSpecific(denies);
    return {
      allowed: false,
      reason: `denied by ${g.subjectType}:${g.subjectId} deny ${g.capability} on ${g.resourceType} ${g.resourcePath}`,
      grant: g,
    };
  }

  const allows = matching.filter(
    (g) => g.effect === "allow" && covers(g.capability, capability),
  );
  if (allows.length) {
    const g = mostSpecific(allows);
    return {
      allowed: true,
      reason: `allowed by ${g.subjectType}:${g.subjectId} allow ${g.capability} on ${g.resourceType} ${g.resourcePath}`,
      grant: g,
    };
  }

  if (capability === "read" && spacePolicy.defaultRole === "read") {
    return { allowed: true, reason: `space default read (${resource.spaceKey})` };
  }

  return { allowed: false, reason: "no matching grant" };
}

// ---- Global (org-level) actions — role-gated, per permissions.md §6 ----

export type GlobalAction =
  | "managePermissions" // create/define scopes & grants
  | "manageGroupsScopes"
  | "manageRolesUpToEditor" // set a user's role up to Editor
  | "viewAudit"
  | "assignAdmin" // assign/revoke Admin
  | "assignSuperAdmin"
  | "orgConfig"; // auth, repo, AI routing, break-glass

/** Minimum role required for each global action. */
const GLOBAL_MIN_ROLE: Record<GlobalAction, Role> = {
  managePermissions: "admin",
  manageGroupsScopes: "admin",
  manageRolesUpToEditor: "admin",
  viewAudit: "admin",
  assignAdmin: "super",
  assignSuperAdmin: "super",
  orgConfig: "super",
};

export function canGlobal(principal: Principal, action: GlobalAction): boolean {
  return ROLE_RANK[principal.role] >= ROLE_RANK[GLOBAL_MIN_ROLE[action]];
}

/** Whether `actor` may set a user's role to `target` (matrix §6): Super sets any;
 *  Admin sets up to Editor; nobody else. */
export function canSetRole(actor: Principal, target: Role): boolean {
  if (actor.role === "super") return true;
  if (actor.role === "admin") return ROLE_RANK[target] <= ROLE_RANK["editor"];
  return false;
}
