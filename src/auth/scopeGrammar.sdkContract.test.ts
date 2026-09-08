// ---------------------------------------------------------------------------
// Conformance guard: this package's ops-letter set vs the SDK's own published
// scope grammar.
//
// `useScopeGate` mirrors a catalog the platform owns — the op letters of the
// compact `resource:ops[:qualifier]` form. A mirror can only ever follow, and
// this one had already fallen a letter behind once: `x` (execute a stored
// script) shipped in the API while the hook went on treating any ops segment
// carrying it as unparseable. That does not deny cleanly — it drops the entry
// out of ops-union evaluation and answers from an exact-string fallback
// instead.
//
// A test pinning `OPS_LETTERS` against a literal written here would go green on
// a catalog that had already drifted, because both sides of the comparison
// would live in this repository, in this language, edited together. It would
// cover one copy of a two-language catalog while reading as proof of both. So
// this test reads the OTHER side: the `allowed_actions` description the SDK
// publishes on `ScopeClause`, generated from the API's own annotation of that
// field.
//
// **What this is NOT.** It is not the deciding artifact. The API decides the
// letter set in its own authoring validator, and this description is a
// hand-written prose copy of that decision which can itself lag — so a green
// here means "the mirror agrees with what the SDK publishes", never "the mirror
// is correct". It is simply the nearest observable proxy available to a package
// whose only view of the platform is the SDK it depends on.
//
// The guard fires on an SDK re-pin rather than on an edit here, which is the
// point: whoever raises the pin learns that the grammar moved, in the package
// whose gate has to move with it.
//
// **Two residuals, stated rather than papered over.** Between the API shipping
// a letter and someone repinning, the mirror is drifted and this is green.
// And a letter announced only in unquoted prose — no slash-run, no quoted
// letter, no worked example — is invisible to every check below. Both are
// unavoidable from a package whose only view of the platform is prose it
// parses; neither is a reason to trust a green here more than it deserves.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { OPS_LETTERS, isOpsString } from './useScopeGate';

/**
 * The placeholder the description uses to STATE the grammar rather than to
 * exemplify it. `resource:ops` is action-SHAPED but its ops segment is the word
 * "ops", so it has to be dropped before the examples are checked.
 *
 * Kept as an explicit, one-entry list, and worth knowing exactly how much that
 * costs: a NEW placeholder is caught loudly only if it is spelled in the same
 * lowercase `word:word` shape (it then fails `isOpsString` and reds this file).
 * Spelled `'<resource>:<ops>'`, `'{resource}:{ops}'` or `'RESOURCE:OPS'` it
 * fails the example pattern instead and is silently skipped — no false green
 * about the LETTERS, which the separate assertion below owns, but one fewer
 * example than the floor is counting on.
 */
const METASYNTAX: ReadonlySet<string> = new Set(['resource:ops']);

/**
 * The `allowed_actions` doc comment from the SDK's generated `ScopeClause`
 * type, with the JSDoc framing stripped.
 *
 * Resolved through node's own module resolution rather than a hardcoded
 * `node_modules` path, so a hoisted or a nested install both work. The type
 * sits beside the SDK's entry point in its published output; if a future SDK
 * reorganizes that layout this throws, and a loud failure is the correct
 * outcome — the guard has gone blind and needs re-deriving, which is exactly
 * what it must never do silently.
 */
function sdkTypeSource(): { source: string; packageDir: string } {
  const sdkEntry = createRequire(import.meta.url).resolve('@vectros-ai/sdk');
  const distDir = dirname(sdkEntry);
  return {
    source: readFileSync(join(distDir, 'api', 'types', 'ScopeClause.d.ts'), 'utf8'),
    // The published package exposes only its root in `exports`, so the manifest
    // cannot be `require`d by subpath — read it off the resolved entry instead.
    packageDir: dirname(distDir),
  };
}

function allowedActionsDescription(source: string): string {
  // Tempered so the capture cannot span an EARLIER doc comment and pull another
  // field's prose in with it — the block must be the one immediately above
  // `allowed_actions`, not everything from the top of the file down to it.
  const block = source.match(/\/\*\*((?:(?!\/\*\*)[\s\S])*?)\*\/\s*allowed_actions\s*\??\s*:/);
  if (!block?.[1]) {
    throw new Error(
      "Could not find the allowed_actions doc comment in the SDK's ScopeClause type. Its " +
        'published shape changed; re-derive this guard against whatever now carries the scope ' +
        'grammar rather than deleting it.',
    );
  }
  return block[1].replace(/^\s*\*[ \t]?/gm, '');
}

/**
 * The description with intra-word apostrophes folded away, so quote pairing
 * survives them.
 *
 * The prose quotes with `'` and also writes `your tenant's own users`, `doesn't`
 * and the like. An unbalanced apostrophe desynchronizes every pair after it,
 * which does not fail — it silently shrinks what this guard can see, and a
 * guard that quietly sees less is the failure mode this whole file exists to
 * avoid. Letter-apostrophe-letter is never a quote delimiter, so folding it is
 * safe and covers every contraction and possessive-`s`. A plural possessive
 * (`tenants' own`) is letter-apostrophe-SPACE, which is indistinguishable from
 * a closing quote by shape alone — {@link desyncEvidence} catches that instead.
 */
function normalized(description: string): string {
  return description.replace(/([A-Za-z])'([A-Za-z])/g, '$1$2');
}

/** Every single-quoted token in the description. */
function quotedTokens(description: string): string[] {
  return [...description.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

/**
 * Tokens that prove quote pairing has desynchronized.
 *
 * Every legitimately quoted token in this description is a short identifier or
 * a worked example. A "token" that runs to sentence length, or carries sentence
 * punctuation, is not a token at all — it is the span between a stray
 * apostrophe and the next real quote, and everything it swallowed has become
 * invisible to the checks below. Parity alone cannot catch this: strays arrive
 * in pairs as readily as singly, and an even count restores parity while
 * leaving the content between them unread.
 */
function desyncEvidence(description: string): string[] {
  return quotedTokens(description).filter((t) => t.length > 60 || /[.;] /.test(t));
}

/**
 * Every op letter the description names, from the two shapes it uses to name
 * one: a slash-run (`the letters c/r/u/d`) and a letter quoted on its own
 * (`plus 's' for sensitive-field REVEAL`).
 *
 * The slash-run needs three or more letters. Two-letter runs are ordinary
 * English abbreviations — `w/o`, `n/a` — and admitting them puts letters into
 * this set that the API never named, which under the equality assertion below
 * would produce a confident RED telling the reader to widen `OPS_LETTERS`. A
 * guard that fails with wrong advice is one someone eventually deletes.
 */
function lettersNamedBy(description: string): Set<string> {
  const letters = new Set<string>();
  for (const run of description.match(/\b[a-z](?:\/[a-z]){2,}\b/g) ?? []) {
    for (const letter of run.split('/')) letters.add(letter);
  }
  for (const quoted of quotedTokens(description)) {
    if (/^[a-z]$/.test(quoted)) letters.add(quoted);
  }
  return letters;
}

/**
 * Every quoted `resource:ops[:qualifier]` token in the description.
 *
 * These are worked examples of the grammar, and the extractor cannot tell an
 * example from a COUNTEREXAMPLE: the description quotes `documents:r:invoice`
 * and `profiles:r:self` precisely to say they are rejected at authoring time.
 * That is harmless while every counterexample is rejected for its QUALIFIER
 * (their ops segments are ordinary letters), and it would misfire on a future
 * counterexample built from a deliberately invalid ops segment. Read a failure
 * here as "the ops segment of a token the SDK quotes does not parse", and check
 * which kind of token it was before widening anything.
 */
function actionExamplesIn(description: string): string[] {
  return quotedTokens(description).filter(
    (t) => /^[a-z][a-z-]*:[a-z]+(?::.+)?$/.test(t) && !METASYNTAX.has(t),
  );
}

describe('scope grammar vs the SDK’s published allowed_actions contract', () => {
  const { source, packageDir } = sdkTypeSource();
  const description = normalized(allowedActionsDescription(source));
  const namedLetters = lettersNamedBy(description);
  const examples = actionExamplesIn(description);

  // Everything below compares this package against whatever SDK is INSTALLED,
  // and the comparison is only as meaningful as that install. An older SDK
  // names fewer letters, so it agrees with a mirror that has drifted — a green
  // that means nothing. This is not hypothetical: several workspaces in this
  // repository pin different SDK builds, and which one a given install hoists
  // is a resolution outcome nothing here would otherwise observe.
  test('the installed SDK is the one this package pins', () => {
    const installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    const declared = JSON.parse(
      readFileSync(createRequire(import.meta.url).resolve('../../package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };
    expect(
      installed.version,
      'the resolved @vectros-ai/sdk is not the build this package declares, so every ' +
        'assertion below is being made against the wrong side of the comparison — reinstall ' +
        'before trusting a green here',
    ).toBe(declared.devDependencies?.['@vectros-ai/sdk']);
  });

  // A guard that can no longer see its subject must fail, not pass. These are
  // structural checks on the parse — "the description still reads the way this
  // parser assumes" — deliberately NOT assertions about which letters it
  // carries today, which would put this repository back on both sides.
  test('the published description is still parseable — this guard can see', () => {
    expect(
      desyncEvidence(description),
      'quote pairing desynchronized: the token(s) below span sentences, which means a stray ' +
        'apostrophe swallowed the prose between them and the checks below are reading less ' +
        'than they appear to',
    ).toEqual([]);
    // 12 is what the PREVIOUS SDK's description yielded, not what the current
    // one does (16). Flooring at today's count would pin this repository against
    // its own snapshot and red on a legitimate trim; flooring far below it lets
    // the parser lose half its view and still pass. The older count is the one
    // number available that is neither.
    expect(
      examples.length,
      'far fewer resource:ops examples could be read out of the SDK’s allowed_actions ' +
        'description than any published version has carried — the wording changed and this ' +
        'guard is now partly blind',
    ).toBeGreaterThanOrEqual(12);
  });

  // EQUALITY, not subset, and both directions earn their keep. Subset-only was
  // the first shape of this test and it was one-directional twice over: a
  // letter this package holds that the API does not name (a typo widening the
  // mirror) passed silently, and so did a reworded description from which a
  // letter simply vanished from the parser's view.
  test('the op letters the SDK names are exactly the ones this package recognizes', () => {
    const sdkNames = [...namedLetters].sort().join('');
    const packageKnows = [...OPS_LETTERS].sort().join('');
    expect(
      sdkNames,
      `The SDK's allowed_actions description names op letters '${sdkNames}'; OPS_LETTERS is ` +
        `'${OPS_LETTERS}'. If the SDK names one this package lacks, an ops segment carrying it ` +
        'is not parsed as an ops string at all — the grant and the ask both fall out of ' +
        'ops-union evaluation into exact-string matching, so a grant spelled exactly like the ' +
        'ask still answers true while every other spelling of the same permission, and asks ' +
        'for the OTHER letters on that resource, answer false: widen OPS_LETTERS. If this ' +
        'package holds one the SDK does not name, check whether the letter was retired or ' +
        'whether the description simply stopped naming it in a shape this parser reads — ' +
        'narrowing on the second would break a live grant.',
    ).toBe(packageKnows);
  });

  test('every action example the SDK publishes parses as an ops string', () => {
    for (const example of examples) {
      const ops = example.split(':')[1] ?? '';
      expect(isOpsString(ops), `ops segment of the published example '${example}'`).toBe(true);
    }
  });
});
