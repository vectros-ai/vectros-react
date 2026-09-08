// ---------------------------------------------------------------------------
// useScopeGate — data-driven UI gating from the session's token scope.
//
// Surfaces (nav items, action buttons, etc.) should render conditionally on
// whether the signed-in user actually has permission for them. This hook
// reads the allowed actions + identity from the mint response's resolved
// scope and exposes a `can(action)` predicate the UI uses to gate.
//
// **Where the scope comes from.** Every mint/exchange/assume endpoint resolves
// `allowedActions`/`identity` server-side from the SAME plaintext scope data
// that gets compressed into the token's own `scope` claim, and returns it
// alongside the token. `useScopeGate` reads that field via
// `getVectrosResolvedScope` (vectrosApiTokenCache.ts) — it never decodes the
// token itself.
//
// **This replaces a client-side JWT/compressed-`scope`-claim decode this file
// used to do.** That approach required a SECOND-LANGUAGE decoder for the
// platform's compressed `scope` claim — a duplicated preset DEFLATE
// dictionary in this package that could silently drift from the backend's
// own copy. The backend now resolves the SAME plaintext data it's about to
// compress and hands the plaintext back directly, so there's nothing left to
// decode (or drift) on this side.
//
// **No signature verification on the resolved scope either** — same as the
// old client-side decode: the backend re-verifies scope on every real
// request, so a client-visible value (however it arrives) is a UX
// optimization only. Nothing gated here is a security boundary; a tampered
// value buys a rendered button and a refusal from the API behind it.
//
// **What this hook CAN get wrong, in both directions.** An earlier version of
// this note claimed the worst case was showing surface the API then rejects,
// "never the reverse". That is not true and the reverse is the likelier half:
// `canPerform` answers conservatively wherever it cannot prove a grant, so it
// can HIDE surface the caller is in fact entitled to — an unqualified grant
// does not satisfy a qualified ask, and the platform's own authorizer is wider
// there. Neither direction is a security defect; both are UX ones, and the
// hiding direction is the one that reaches a user as "the app is broken"
// rather than as an error message. See {@link canPerform}.
//
// **Tenant scope:** the hook reads the active tenant from `useCurrentTenant()`
// (the TenantSwitcher-controlled tenant) by default; an optional
// `tenantOverride: TenantId` checks a specific tenant instead.
//
// **File split rationale:** the `<ScopeGate>` component is in
// `./ScopeGate.tsx`. Hooks and components live in separate files per the
// admin-app convention (matches useAuth.ts + AuthProvider.tsx) — keeps
// react-refresh HMR clean and the auth barrel's re-exports unambiguous.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

import type { PartnerApiResolvedScope } from './vectrosApiTokenCache';
import { getVectrosResolvedScope } from './vectrosApiTokenCache';
import type { TenantId } from './types';
import { useCurrentTenant } from './useCurrentTenant';

/** Public shape returned by useScopeGate. */
export interface ScopeGateValue {
  /** True until the first token mint resolves. UIs typically render nothing during loading. */
  readonly loading: boolean;
  /** The resolved `allowedActions`. Empty array if the mint response had none, or while loading. */
  readonly allowedActions: ReadonlyArray<string>;
  /**
   * The resolved `identity` — the ownership dimensions (canonical `scope:<ns>`
   * keys, plus `userId` when the credential is bound to a specific user) THIS
   * session's own credential holds, if any. Empty object for a credential
   * with none (an OWNER session, which is never bound to a specific identity)
   * or while loading. This is NOT the same question as `can(action)` —
   * holding an identity value doesn't grant an action, and holding an action
   * doesn't confer an identity. It answers a narrower question some surfaces
   * need: "does this session's own credential hold an identity value it
   * could legitimately confer onto something else?" (see the platform's
   * identity-conferral rule — a caller may grant exactly the identity value
   * it itself holds, never an arbitrary one).
   */
  readonly identity: Readonly<Record<string, string>>;
  /**
   * Predicate: can the current session perform `action`? Wildcard `*` grants
   * everything. For the compact `resource:ops` form (e.g. `'users:r'`,
   * `'users:cru'`), this unions ops across every UNQUALIFIED granted entry
   * for that resource — so a caller holding `users:c` + `users:r` + `users:u`
   * as three separate entries, or one combined `users:cru` entry, both
   * satisfy `can('users:ru')`. See {@link canPerform} for the exact rules
   * (in particular: why a qualified grant does NOT count toward an
   * unqualified ask, and why a malformed ops string falls back to an exact
   * string match rather than silently matching nothing).
   */
  readonly can: (action: string) => boolean;
}

/**
 * The op letters the platform's compact `resource:ops[:qualifier]` grammar
 * recognizes: `c`/`r`/`u`/`d` (create/read/update/delete), `s` (sensitive-field
 * reveal) and `x` (execute a stored script).
 *
 * **This is a MIRROR of a catalog the platform owns, and it can only ever
 * follow.** The set is decided by the API's own authoring validator, which this
 * package cannot see. The nearest OBSERVABLE statement of it is the SDK's
 * published contract — the `allowed_actions` description on `ScopeClause` —
 * which is itself a prose copy of that decision and can lag it. So agreeing
 * with the SDK is the strongest check available here, and it is not the same
 * thing as being right.
 *
 * **A letter the platform adds and this list lacks does not fail cleanly**,
 * which is why it is worth a guard rather than a note. An ops segment carrying
 * an unknown letter stops being recognized as an ops string AT ALL, so both the
 * grant and the ask drop out of the ops-union path below and into the
 * exact-match fallback. That degrades quietly and asymmetrically: a grant
 * spelled character-for-character like the ask still matches — the simplest
 * case, and the one a developer checks first — while every other spelling of
 * the same permission starts answering `false`, INCLUDING asks for unrelated
 * letters on a resource whose grant merely mentions the unknown one.
 *
 * `scopeGrammar.sdkContract.test.ts` is that guard: it reads the letters and
 * the worked examples out of the installed SDK's own `allowed_actions`
 * description and fails when this list cannot parse them. A test that pinned
 * this constant against a copy of itself would cover one side of a
 * two-language catalog while reading as proof of both.
 */
export const OPS_LETTERS = 'crudsx';

/** True when every character of `s` is a recognized op letter, and `s` is non-empty. */
export function isOpsString(s: string): boolean {
  return s.length > 0 && [...s].every((c) => OPS_LETTERS.includes(c));
}

/**
 * Ops-aware capability check: does `allowedActions` grant `action`?
 *
 * `action` may be:
 * - the wildcard `*` (not meaningful as an ask, but handled for symmetry — `*` is
 *   never true unless `allowedActions` itself carries wildcard, same as any other ask);
 * - the compact `resource:ops` form — e.g. `'users:r'`, `'users:cru'` — evaluated by
 *   OPS-UNION: every entry in `allowedActions` shaped exactly `resource:ops` (no
 *   qualifier) for the SAME resource contributes its ops letters to a running set;
 *   `action` is granted when every one of its own ops letters is in that set. This is
 *   what lets a caller's grant be spread across several entries (`users:c`, `users:r`,
 *   `users:u`) or combined into one (`users:cru`) and still be recognized identically —
 *   the shape the split-entries authoring path produces and the combined-entry path
 *   also produces are the same grant.
 * - the qualified `resource:ops:qualifier` form — e.g. `'records:r:case'` — evaluated by
 *   the SAME ops-union, narrowed to entries sharing BOTH the resource AND the exact
 *   qualifier. `'records:crud:case'` (one combined qualified entry, the shape a role's
 *   `allowedActions: [records:crud:case]` clause produces) satisfies an ask for
 *   `'records:r:case'` the same way `'users:cru'` satisfies `'users:r'` — this is NOT the
 *   widening the module doc's "qualified grant into unqualified ask" warning is about:
 *   the qualifier is identical on both sides, so nothing is generalized across resource
 *   instances. A qualified GRANT still never contributes to an ask with a DIFFERENT
 *   qualifier, or to an unqualified ask (that path is untouched); an UNQUALIFIED grant
 *   still never contributes to a qualified ask either (seen only via the exact-match
 *   fallback below, unchanged) — both keep the conservative, never-wider-than-what's-
 *   granted property the unqualified case already has.
 *
 *   What a qualifier MEANS is the platform's rule, not this predicate's: which
 *   resources correlate a qualifier, and on which op letters, is decided by the API at
 *   authoring time (the SDK's `allowed_actions` description states the current set),
 *   and this predicate only compares qualifier segments for equality. Two consequences
 *   are worth knowing before writing an ask. An entry whose qualifier the platform
 *   would refuse to author can never reach a resolved scope, so asking for one gets
 *   nothing out of the union path — though a wildcard-scoped session still answers
 *   `true` to any ask at all, short-circuiting above. And a BARE grant that covers every
 *   instance — `scripts:x`, meaning every script — does NOT satisfy a per-instance ask
 *   like `scripts:x:daily-report`, because an unqualified grant never feeds a qualified
 *   ask; the API itself is wider here and would allow the call. Gate a "can execute
 *   scripts at all" surface on the bare form — unless your credentials carry per-script
 *   grants, because the mirror image is also true and also narrower than the API: a
 *   credential holding only `scripts:x:daily-report` answers `false` to a bare
 *   `scripts:x` ask, so gating the surface on the bare form alone would hide it from
 *   exactly the caller the per-script grant was issued for. Where both shapes are in
 *   play, ask for both and accept either.
 *
 *   Both narrowings are the same property seen from two sides: this predicate never
 *   generalizes across the qualifier boundary, in either direction. The safety of NOT
 *   modelling the platform's per-resource qualifier rules rests on an invariant it
 *   cannot check — that the API refuses to author a qualifier it would not enforce, so
 *   an entry whose qualifier is meaningless never reaches a resolved scope in the first
 *   place.
 *
 *   One shape this predicate does not reach at all: a qualifier that itself contains a
 *   colon. The ask is split unbounded, so such an action yields more than three segments
 *   and drops straight to exact matching, whatever the platform would make of it.
 * - anything else (a bare custom verb, an ask/grant whose ops segment isn't a
 *   recognized ops string, or a length mismatch between ask and grant) — falls back to
 *   an EXACT string match against `allowedActions`. This is deliberate, not an
 *   oversight — the exact-match fallback is the conservative choice: never wider than
 *   what the caller can prove.
 */
export function canPerform(
  allowedActions: ReadonlyArray<string>,
  action: string,
): boolean {
  if (allowedActions.includes('*')) return true;

  const askedSegs = action.split(':');
  if (askedSegs.length === 2 || askedSegs.length === 3) {
    const [resource, askedOps, askedQualifier] = askedSegs;
    if (resource && isOpsString(askedOps ?? '')) {
      let grantedOps = '';
      for (const raw of allowedActions) {
        const segs = raw.split(':');
        if (segs.length !== askedSegs.length) continue; // shape mismatch — not unioned in
        const [grantedResource, grantedOpsStr, grantedQualifier] = segs;
        if (grantedResource !== resource) continue;
        if (askedSegs.length === 3 && grantedQualifier !== askedQualifier) continue;
        if (!isOpsString(grantedOpsStr ?? '')) continue;
        for (const c of grantedOpsStr ?? '') {
          if (!grantedOps.includes(c)) grantedOps += c;
        }
      }
      if (grantedOps) {
        return [...(askedOps ?? '')].every((c) => grantedOps.includes(c));
      }
      // No same-shape entry matched at all (e.g. only an unqualified grant exists
      // for a qualified ask, or vice versa) — fall through to exact-match below
      // rather than report denial from an empty union, so a literal-string grant
      // shaped exactly like the ask is still recognized.
    }
  }

  return allowedActions.includes(action);
}

const EMPTY_ACTIONS: ReadonlyArray<string> = [];
const EMPTY_IDENTITY: Readonly<Record<string, string>> = {};
const EMPTY_RESOLVED: PartnerApiResolvedScope = { allowedActions: EMPTY_ACTIONS, identity: EMPTY_IDENTITY };

/**
 * Read the current session's allowed actions and expose a can-do predicate.
 *
 * Loading state is true until the first token mint resolves. Consumers
 * typically render nothing (or a skeleton) during loading. For nav items
 * specifically, hiding-during-load is preferred over a flash-of-content.
 *
 * @param tenantOverride force a specific tenant scope to read. Omit to read
 *                       from `useCurrentTenant()` (the TenantSwitcher-controlled
 *                       active tenant). Override is rare — typically only to
 *                       check permissions against a DIFFERENT tenant than the
 *                       active one.
 */
export function useScopeGate(tenantOverride?: TenantId): ScopeGateValue {
  const { tenant } = useCurrentTenant();
  const tenantId = tenantOverride ?? tenant;
  const [resolved, setResolved] = useState<PartnerApiResolvedScope | null>(null);

  useEffect(() => {
    // No active tenant yet (memberships still loading) — stay in the loading
    // state; the effect re-runs once a tenant resolves.
    if (tenantId == null) return;
    let cancelled = false;
    // Reset to loading on a tenant change so `can()`/`identity` don't report
    // the PRIOR tenant's claims during the re-mint — otherwise a scoped user
    // switching tenants briefly gates routes on the old tenant's scope.
    setResolved(null);

    // The retry-on-a-failed-mint logic used to live here, per hook instance.
    // Moved DOWN into vectrosApiTokenCache.ts's getVectrosApiToken itself
    // (2026-08-26) — several independent consumers (this hook, on nav items
    // for different actions) each call getVectrosApiToken (and
    // getVectrosResolvedScope, which delegates to it) around the same moment,
    // and a per-instance retry here couldn't stop each one from independently
    // racing its OWN fresh mint the instant its predecessor's failure cleared
    // the shared slot. Retrying inside the cache's own in-flight promise means
    // every consumer arriving during the retry window joins the SAME attempt
    // instead of starting an independent one. See that module's
    // SHARED_MINT_RETRY_DELAY_MS doc for the full story.
    getVectrosResolvedScope(tenantId)
      .then((scope) => {
        if (!cancelled) setResolved(scope ?? EMPTY_RESOLVED);
      })
      .catch(() => {
        // Mint failure (network, expired session, etc.) → treat as no
        // actions/identity. The UI hides everything until the user retries
        // or signs out + back in. Clean degraded mode.
        if (!cancelled) setResolved(EMPTY_RESOLVED);
      });
    return (): void => {
      cancelled = true;
    };
  }, [tenantId]);

  const allowed = resolved?.allowedActions ?? EMPTY_ACTIONS;
  const identity = resolved?.identity ?? EMPTY_IDENTITY;
  const can = (action: string): boolean => canPerform(allowed, action);

  return {
    loading: resolved === null,
    allowedActions: allowed,
    identity,
    can,
  };
}
