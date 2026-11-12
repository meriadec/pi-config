# Tooling errors in past sessions

Data: 4,600 sessions in `agent/sessions` (231,162 tool results, 11,347 errors).
Tooling error = the agent or its tools misbehaved. A failing test or lint is not one.
Counts come from `bun analytics/cli.ts errors`. Replay numbers come from `bun analytics/tool-hints-replay.ts`.
Shares are of the 3,076 tooling-caused errors, unless the line says otherwise.
Examples are shown as shapes only. No file content, no secrets, no full paths.

## Summary table

| Class                     | Count | Share | Proven cause                                                                                                                   | Fix                                                | Replay match |
| ------------------------- | ----: | ----: | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -----------: |
| `path-not-found` (`read`) | 1,377 |   45% | 41% image reads of a file that does not exist yet (parallel race); 13% guessed directory; 9% typo or guess in a real directory | tool-hints read rule + 1 line in `agent/AGENTS.md` |        1,335 |
| `path-not-found` (`bash`) |   469 |   15% | Guessed paths in `rg`/`ls`/`sed`; often a partial success                                                                      | none (see below)                                   |            0 |
| `edit-bad-anchor`         |   378 |   12% | 70% anchors the model never saw, or malformed                                                                                  | tool-hints edit rule                               |          378 |
| `edit-multi-match`        |   241 |    8% | 195 built-in `oldText` edits (June to September, before hashline); 46 hashline `replace_text`                                  | none needed now                                    |            0 |
| `edit-no-match`           |   181 |    6% | Built-in `oldText` era (June to August). 2 in October                                                                          | none needed now                                    |            0 |
| `edit-schema-invalid`     |   139 |    5% | One model (claude-opus-4.8) in August, wrong argument names                                                                    | none possible (see below)                          |            0 |
| `timeout` (old rule)      |   332 |   n/a | Only 120 are real bash timeouts; 212 were misclassified                                                                        | `classify.ts` fix                                  |          n/a |
| `edit-would-empty`        |    43 |    1% | Model deletes a whole file with `lines: []`                                                                                    | upstream issue                                     |            0 |
| `edit-conflict`           |    24 |    1% | 18 `prepend` + `replace` on the same line                                                                                      | upstream issue                                     |            0 |
| `edit-empty-request`      |    13 |   <1% | `edit` called with `{}` or without `path`                                                                                      | none (see below)                                   |            0 |
| `browser-launch`          |    67 |    2% | Chrome has no usable sandbox on this host                                                                                      | host setting (see below)                           |            0 |

Monthly shape (tooling classes): `read` ENOENT grows (Aug 507, Sep 502, Nov 563). Anchor errors peaked in September (261) and are 1 in November, because `edit` use fell. Schema errors: 123 of 139 in August.

## path-not-found, `read` (1,377)

Method: all 1,377 failing reads were joined to the call arguments, the session `cwd`, and the other calls of the same assistant message.

| Pattern                                                            | Count | Share of reads |
| ------------------------------------------------------------------ | ----: | -------------: |
| Image path (`png`, `jpg`, `webp`, `gif`)                           |   567 |            41% |
| Not an image, directory missing (guessed path)                     |   184 |            13% |
| Not an image, directory exists, file missing (guess or typo)       |   122 |             9% |
| Not an image, session `cwd` is gone today, so the split is unknown |   504 |            37% |

Image reads, proven cause: **race between tool calls.** Tool calls of one assistant message run in parallel (`docs/extensions.md`, "parallel by default"). In 436 of 567 image reads, a sibling call of the same message named the same file (shape: `bash: agent-browser screenshot <path>` + `read: <path>`). In 309 of those 436, the same path was read successfully later. The 127 others never succeeded: the producer command probably failed too. The `/tmp/*.png` reads alone are 340.

Reads in a missing directory: the model guesses a path (shape: `read {path, offset: 1, limit: 400, raw: true}` in a batch of 4 to 9 parallel reads). I read 25 samples by hand. They match this shape. I did not measure how many have an earlier listing of the path.

Fix 1 (done): the `tool-hints` extension adds one hint line to a failing `read`:

- image path: "calls run in parallel: read it in the next message";
- directory exists: up to 3 similar names (one scan, 200 entries at most);
- directory missing: the nearest existing directory, and "removed worktree" when the path has `worktrees/`.

Fix 2 (done): one line in `agent/AGENTS.md`: never `read` a file in the same message as the command that creates it. The data proves it for 309 reads (22% of read ENOENT).

Replay: 1,335 of 1,377 failing reads get a hint (image-missing 532, dir-missing 684, dir-no-match 85, similar-name 34). The 42 left exist today, so the rule stays silent. Limit: the replay uses today's file system. Most old worktrees are gone, so `similar-name` is a low bound.

Not verified: I cannot prove from history that a hint changes the next call. I only measured the match. Check later with `bun analytics/cli.ts errors` for `read:path-not-found` after 2 weeks.

## path-not-found, `bash` (469)

Pattern: `rg`, `ls`, `sed`, `grep` with one guessed path. In the samples I read, several are partial successes (other paths printed output, exit code 1 or 2). Cause is path guessing by the model. No safe hint exists: the hook cannot tell which path is wrong. Not fixed.

## edit-bad-anchor (378)

All 378 come from `pi-hashline-edit` 0.8.3 (12,367 hashline calls: 3.1% failure rate). Hashline hash = line + both neighbours, so any edit near a line stales its anchor. A successful edit result says "Anchors omitted; use read for subsequent edits".

Method: for each error, I looked at all earlier read/grep/edit results of the same path in the same session, and I checked whether the failing anchor text ever appeared.

| Cause                                                                           | Count | Share |
| ------------------------------------------------------------------------------- | ----: | ----: |
| Malformed ref (`N#` without hash, 2 letters wrong, `#??`)                       |    91 |   24% |
| Anchor never shown for this path (invented, or beyond the read range)           |   177 |   47% |
| File changed after the read, own earlier `edit` in between                      |    42 |   11% |
| Anchor was shown, file changed in another way (formatter, shell, other process) |    68 |   18% |

Examples of the "never shown" shape: `read {offset: 1, limit: 390}` then `edit {pos: "391#TR"}`. The model uses a line outside the read range. 149 of 172 stale cases with a read have zero calls between the read and the edit (median gap 9.6 s), so this is not drift. It is invented anchors.

Fix 3 (done): `tool-hints` tracks which anchors each read showed, and adds a hint to the error:

- malformed: "copy each anchor exactly as LINE#HASH";
- never shown: "anchor N#HH was never shown by a read of this file. Read lines near N";
- edited since read, or changed since read: "read again".

Replay: 378 of 378 get a hint (never-shown 177, changed-since-read 68, edited-since-read 42, malformed-ref 91). Max hint size 141 bytes.

The error text already says "re-read". The new part is the reason and the exact range to read. The hint cannot prevent the first failure. A `tool_call` block could, but the rule says the hook must not block.

### Upstream issue text (for `pi-hashline-edit`)

> **Title:** Fewer failed edits: reject never-shown anchors early, merge adjacent ops, return fresh anchors
>
> In 12k real calls with 0.8.3, 3.1% fail with `E_STALE_ANCHOR` or `E_BAD_REF`.
>
> 1. 47% of failing anchors were never printed by any `read` of that file (line outside the read range). Please say so in the error ("line 391 is outside the last read range 1-390") instead of only "re-read".
> 2. `edit` success says "Anchors omitted". The next edit then fails 11% of the time. Please return fresh anchors for the changed region.
> 3. `E_EDIT_CONFLICT`: 18 of 24 are `prepend before N` plus `replace N..M` in one call. Please merge them (prepend lines go before the replacement lines).
> 4. `E_WOULD_EMPTY`: 43 times the model replaced lines 1..last with `lines: []` to delete a file. Please add "use `rm` to delete a file" to the message.
> 5. `E_BAD_REF`: 24 of 91 have `N#` with no hash. Please say "run read to get the hash" in that case.

## edit-multi-match (241), edit-no-match (181)

195 of 241 multi-match errors are built-in `oldText` edits ("Found N occurrences of edits[i]"), plus all `edit-no-match`. Both stop after August when hashline replaced the built-in tool. The 46 hashline `E_MULTI_MATCH` come from `replace_text`. Message already says "use hashline edits". No fix needed.

## edit-schema-invalid (139)

123 are from August with claude-opus-4.8: the model used flat or mistyped arguments (shapes: `edit {edits:[{newText}]}` without `path`; key `edit` instead of `edits`; `<parameter name="oldText">` text inside a string; truncated JSON). `write {file_text}` instead of `content`: 1. Outside August: 16 in total. The error text already names the missing field.

No hook fix is possible: Pi skips `tool_call` and `tool_result` for invalid arguments (`docs/extensions.md`, "invalid arguments skip tool_call"). Nothing to do for a current setup. The classifier counts stay as they are.

## edit-empty-request (13)

Shape: `edit {}` (mostly October) and calls without `path`. Same limit as schema errors. Not fixed.

## timeout (332 under the old rule)

The old rule matched the word "timeout" anywhere. New split:

| Real class                                                    | Count |
| ------------------------------------------------------------- | ----: |
| Real bash tool timeout (`Command timed out after N seconds`)  |   116 |
| agent-browser `wait` gave up (`Wait timed out after 25000ms`) |    87 |
| The word appears in a test or log text                        |   129 |

The 116 real timeouts: `find` over `/home` or `..` 29, check/test/build 15, sleep or server restart 17, cluster/network 16, `kitty @ ls` hang 4, other 35. They have no single cause, so no hint. The tool timeout is chosen by the model. No dev-server wait pattern is proven.

Fix (done): `analytics/classify.ts` now returns `timeout` only for real tool timeouts, and `browser-wait-timeout` (not tooling) for the browser case. Tests added. New counts: `timeout` 120.

## browser-launch (67)

All 67 have the same message: `Chrome exited early ... FATAL ... zygote_host_impl_linux.cc: No usable sandbox`. Host facts: `kernel.apparmor_restrict_unprivileged_userns=1`. The tool output already says "try --args --no-sandbox". 40 of 67 are in August. Only 1 in November.

Recommended host fix (not in this repo): set `AGENT_BROWSER_ARGS=--no-sandbox` in the shell profile or add an AppArmor profile for the browser. This changes the browser sandbox, so the human must decide. Not changed.

## What was not verified

- The effect of the hints on the next call (history has no hint). Replay counts matches only.
- `similar-name` matches are a low bound: old worktrees are gone.
- Whether parallel image reads fail in `read` because of timing or because the producer failed (127 reads never succeeded).
- The bash `path-not-found` share of real failures (I read samples only).
