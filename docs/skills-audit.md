# Skills audit

Data: all sessions in `agent/sessions` up to 2026-11-12. Command: `bun analytics/skills-report.ts`.

## How to read the numbers

- A session **invokes** a skill if it has one of: a user message that starts with `<skill name="X"` (this is what `/skill:X` makes), a `read` of `X/SKILL.md`, or a raw `/skill:X` text. A session counts once per skill. _loads_ counts injections and reads (a session can load a skill more than once).
- Tool calls, errors, turns and cost are for the **whole invoking session**, not only the part after the load. A skill is not the cause of these numbers. The baseline is about 45 errors per 1000 calls.
- Cost is USD at public API prices (`analytics/cost.ts`). _load tokens_ = bytes/4 of all loads (injected text, or the current SKILL.md size for a read). It is the direct context cost of the skill.
- _extra B (files)_: other files in the skill folder. They load only on demand.

## Skills in `agent/skills/`

| skill                         | link           | SKILL.md B | extra B (files) | sessions | loads | first      | last       | last 60d | tool calls | errors | err/1000 | turns | cost USD | load tokens | never used |
| ----------------------------- | -------------- | ---------- | --------------- | -------- | ----- | ---------- | ---------- | -------- | ---------- | ------ | -------- | ----- | -------- | ----------- | ---------- |
| pr-review-triage              | local          | 8849       | 3477 (1)        | 547      | 552   | 2026-06-19 | 2026-11-10 | 305      | 27277      | 1139   | 41.8     | 20481 | 1094.23  | 1167926     |            |
| create-pr                     | local          | 5731       | 27816 (3)       | 498      | 509   | 2026-06-19 | 2026-11-12 | 249      | 22544      | 1012   | 44.9     | 16456 | 929.16   | 741940      |            |
| grilling                      | symlink        | 1987       | 113 (1)         | 338      | 338   | 2026-06-19 | 2026-11-11 | 132      | 31103      | 1342   | 43.1     | 24794 | 1845.31  | 167902      |            |
| diagnosing-bugs               | symlink        | 8530       | 1419 (2)        | 316      | 322   | 2026-06-18 | 2026-10-28 | 84       | 31282      | 1969   | 62.9     | 21433 | 1583.77  | 692822      |            |
| domain-modeling               | symlink        | 3346       | 5134 (3)        | 271      | 271   | 2026-06-19 | 2026-11-11 | 115      | 26670      | 1150   | 43.1     | 20834 | 1562.64  | 226716      |            |
| grill-with-docs               | symlink        | 247        | 145 (1)         | 244      | 421   | 2026-06-19 | 2026-11-03 | 110      | 22586      | 921    | 40.8     | 17427 | 1192.33  | 66546       |            |
| refine-branch-commits         | local          | 5043       | 0 (0)           | 223      | 225   | 2026-08-05 | 2026-11-05 | 98       | 10507      | 468    | 44.5     | 7543  | 412.11   | 281182      |            |
| codebase-design               | symlink        | 6446       | 5320 (3)        | 211      | 215   | 2026-06-22 | 2026-11-02 | 107      | 20484      | 927    | 45.3     | 12735 | 901.76   | 345789      |            |
| resolve-conflicts             | local          | 4096       | 0 (0)           | 202      | 208   | 2026-06-22 | 2026-11-03 | 92       | 5058       | 359    | 71.0     | 3476  | 127.91   | 202400      |            |
| code-review                   | symlink        | 6589       | 100 (1)         | 143      | 152   | 2026-08-04 | 2026-11-02 | 40       | 10642      | 524    | 49.2     | 6991  | 415.21   | 247198      |            |
| triage                        | symlink        | 6558       | 12744 (3)       | 107      | 112   | 2026-06-18 | 2026-11-02 | 26       | 6878       | 318    | 46.2     | 5736  | 478.54   | 184363      |            |
| review                        | local          | 4698       | 0 (0)           | 94       | 97    | 2026-06-19 | 2026-10-22 | 36       | 9703       | 486    | 50.1     | 5974  | 423.75   | 112307      |            |
| jira                          | local          | 3268       | 3812 (4)        | 81       | 81    | 2026-08-20 | 2026-11-10 | 58       | 8173       | 387    | 47.4     | 6235  | 307.89   | 66180       |            |
| implement                     | symlink        | 433        | 139 (1)         | 79       | 123   | 2026-06-29 | 2026-10-28 | 6        | 6311       | 369    | 58.5     | 4892  | 326.15   | 15625       |            |
| grill-me                      | symlink        | 157        | 137 (1)         | 53       | 82    | 2026-06-23 | 2026-11-02 | 14       | 3998       | 179    | 44.8     | 3241  | 216.46   | 14653       |            |
| extract-refactorings          | local          | 4738       | 0 (0)           | 37       | 37    | 2026-08-20 | 2026-11-02 | 25       | 1634       | 65     | 39.8     | 1172  | 60.40    | 43715       |            |
| bake                          | local          | 3098       | 4095 (1)        | 34       | 38    | 2026-09-24 | 2026-11-02 | 34       | 575        | 19     | 33.0     | 497   | 16.31    | 30564       |            |
| resolving-merge-conflicts     | symlink        | 921        | 113 (1)         | 33       | 33    | 2026-08-12 | 2026-09-25 | 17       | 1342       | 129    | 96.1     | 800   | 31.32    | 7598        |            |
| tdd                           | symlink        | 3550       | 3782 (3)        | 28       | 28    | 2026-06-29 | 2026-09-24 | 12       | 3943       | 285    | 72.3     | 2660  | 216.14   | 24850       |            |
| writing-for-agents            | symlink        | 10886      | 2731 (2)        | 28       | 28    | 2026-08-25 | 2026-11-03 | 17       | 3432       | 159    | 46.3     | 1983  | 176.74   | 77168       |            |
| polish-ui                     | local          | 1848       | 0 (0)           | 26       | 33    | 2026-08-20 | 2026-09-21 | 1        | 2963       | 87     | 29.4     | 1747  | 95.33    | 15276       |            |
| handoff                       | symlink        | 894        | 141 (1)         | 24       | 30    | 2026-08-12 | 2026-11-02 | 18       | 2459       | 133    | 54.1     | 1975  | 142.54   | 7122        |            |
| humanizer                     | symlink        | 30409      | 22516 (8)       | 17       | 17    | 2026-09-01 | 2026-10-29 | 11       | 965        | 50     | 51.8     | 710   | 49.33    | 128701      |            |
| to-issues                     | symlink        | 3319       | 0 (0)           | 12       | 13    | 2026-07-07 | 2026-10-19 | 7        | 1226       | 43     | 35.1     | 848   | 49.60    | 10802       |            |
| writing-great-skills          | symlink        | 9414       | 18638 (2)       | 12       | 13    | 2026-06-20 | 2026-08-20 | 0        | 275        | 11     | 40.0     | 246   | 12.54    | 32325       |            |
| setup-matt-pocock-skills      | symlink        | 6978       | 12994 (6)       | 9        | 9     | 2026-06-28 | 2026-11-03 | 6        | 394        | 20     | 50.8     | 348   | 2.03     | 15570       |            |
| improve-codebase-architecture | symlink        | 6000       | 6807 (2)        | 5        | 5     | 2026-06-22 | 2026-07-03 | 0        | 557        | 28     | 50.3     | 529   | 54.03    | 6971        |            |
| design-an-interface           | symlink        | 3366       | 0 (0)           | 2        | 5     | 2026-07-03 | 2026-08-18 | 0        | 1111       | 86     | 77.4     | 641   | 34.36    | 4208        |            |
| fframes-video                 | symlink        | 14672      | 21135 (3)       | 2        | 2     | 2026-10-01 | 2026-10-21 | 2        | 106        | 9      | 84.9     | 109   | 3.40     | 7121        |            |
| slidev                        | symlink        | 8896       | 59164 (54)      | 1        | 1     | 2026-09-01 | 2026-09-01 | 0        | 89         | 7      | 78.7     | 84    | 3.63     | 2260        |            |
| vault-env                     | local          | 2739       | 44735 (16)      | 1        | 0     | 2026-11-05 | 2026-11-05 | 1        | 9          | 0      | 0.0      | 16    | 0.15     | 0           |            |
| wayfinder                     | symlink        | 12380      | 144 (1)         | 1        | 1     | 2026-10-19 | 2026-10-19 | 1        | 11         | 0      | 0.0      | 12    | 0.66     | 3106        |            |
| write-a-skill                 | broken symlink | 0          | 0 (0)           | 1        | 1     | 2026-08-20 | 2026-08-20 | 0        | 21         | 1      | 47.6     | 15    | 0.35     | 0           |            |
| decision-mapping              | symlink        | 3709       | 0 (0)           | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| diagnose                      | broken symlink | 0          | 0 (0)           | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| implement-spec                | symlink        | 2780       | 168 (1)         | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| stack                         | broken symlink | 0          | 0 (0)           | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| stack-and-peel                | local          | 4516       | 0 (0)           | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| to-prd                        | symlink        | 3027       | 0 (0)           | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| to-spec                       | symlink        | 3043       | 135 (1)         | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |
| to-tickets                    | symlink        | 5671       | 146 (1)         | 0        | 0     | -          | -          | 0        | 0          | 0      | -        | 0     | -        | 0           | NEVER      |

### Skills seen in history but not in `agent/skills/` (already gone or from other repos)

| skill                                               | link | SKILL.md B | extra B (files) | sessions | loads | first      | last       | last 60d | tool calls | errors | err/1000 | turns | cost USD | load tokens | never used |
| --------------------------------------------------- | ---- | ---------- | --------------- | -------- | ----- | ---------- | ---------- | -------- | ---------- | ------ | -------- | ----- | -------- | ----------- | ---------- |
| do-work (not in agent/skills)                       | -    | -          | -               | 269      | 290   | 2026-06-18 | 2026-08-12 | 0        | 22186      | 1159   | 52.2     | 19184 | 1603.67  | 5802        |            |
| agent-browser (not in agent/skills)                 | -    | -          | -               | 135      | 164   | 2026-06-19 | 2026-10-17 | 33       | 19122      | 1165   | 60.9     | 12972 | 791.73   | 2543        |            |
| manage-docker-images (not in agent/skills)          | -    | -          | -               | 96       | 105   | 2026-08-12 | 2026-10-28 | 27       | 5604       | 318    | 56.7     | 3820  | 356.57   | 142074      |            |
| autonomous-task (not in agent/skills)               | -    | -          | -               | 58       | 345   | 2026-08-19 | 2026-09-24 | 13       | 27791      | 1711   | 61.6     | 13827 | 853.16   | 0           |            |
| web-task-e2e-validate (not in agent/skills)         | -    | -          | -               | 56       | 76    | 2026-07-15 | 2026-09-24 | 2        | 9818       | 674    | 68.6     | 5964  | 354.55   | 0           |            |
| reason-act-harness (not in agent/skills)            | -    | -          | -               | 36       | 40    | 2026-07-07 | 2026-08-04 | 0        | 2172       | 87     | 40.1     | 2014  | 166.55   | 23375       |            |
| minibar-dev-loop (not in agent/skills)              | -    | -          | -               | 33       | 34    | 2026-07-01 | 2026-08-21 | 0        | 2269       | 113    | 49.8     | 1970  | 139.60   | 0           |            |
| dev-agent-web (not in agent/skills)                 | -    | -          | -               | 22       | 39    | 2026-07-07 | 2026-07-08 | 0        | 771        | 29     | 37.6     | 770   | 38.15    | 23764       |            |
| temporal-developer (not in agent/skills)            | -    | -          | -               | 22       | 22    | 2026-06-23 | 2026-08-20 | 0        | 1441       | 85     | 59.0     | 1213  | 94.70    | 1897        |            |
| minibar-cli (not in agent/skills)                   | -    | -          | -               | 20       | 20    | 2026-07-02 | 2026-08-21 | 0        | 964        | 40     | 41.5     | 942   | 61.82    | 0           |            |
| revault-web-browser (not in agent/skills)           | -    | -          | -               | 14       | 15    | 2026-09-24 | 2026-10-02 | 14       | 1626       | 98     | 60.3     | 1261  | 55.39    | 0           |            |
| revault-web-operator (not in agent/skills)          | -    | -          | -               | 8        | 10    | 2026-07-07 | 2026-07-16 | 0        | 218        | 6      | 27.5     | 222   | 11.74    | 1311        |            |
| effect-ts (not in agent/skills)                     | -    | -          | -               | 4        | 4     | 2026-09-18 | 2026-09-20 | 4        | 287        | 12     | 41.8     | 168   | 7.92     | 0           |            |
| pokemap-testing (not in agent/skills)               | -    | -          | -               | 4        | 4     | 2026-11-01 | 2026-11-11 | 4        | 230        | 7      | 30.4     | 241   | 7.26     | 0           |            |
| react-harness (not in agent/skills)                 | -    | -          | -               | 4        | 7     | 2026-07-07 | 2026-07-07 | 0        | 638        | 36     | 56.4     | 505   | 33.88    | 2977        |            |
| release-plan (not in agent/skills)                  | -    | -          | -               | 4        | 4     | 2026-08-10 | 2026-09-22 | 3        | 325        | 16     | 49.2     | 210   | 9.93     | 0           |            |
| component-testing (not in agent/skills)             | -    | -          | -               | 3        | 3     | 2026-09-16 | 2026-09-22 | 3        | 278        | 16     | 57.6     | 160   | 7.65     | 0           |            |
| web-ux-review (not in agent/skills)                 | -    | -          | -               | 3        | 8     | 2026-08-19 | 2026-09-24 | 1        | 673        | 37     | 55.0     | 373   | 30.10    | 0           |            |
| analyze-api-integration-tests (not in agent/skills) | -    | -          | -               | 2        | 3     | 2026-08-20 | 2026-08-21 | 0        | 573        | 30     | 52.4     | 320   | 31.18    | 0           |            |
| component-architecture (not in agent/skills)        | -    | -          | -               | 2        | 2     | 2026-09-16 | 2026-09-22 | 2        | 167        | 11     | 65.9     | 92    | 5.55     | 0           |            |
| external-integrations (not in agent/skills)         | -    | -          | -               | 2        | 2     | 2026-09-03 | 2026-09-07 | 0        | 248        | 15     | 60.5     | 160   | 22.68    | 0           |            |
| open-pr (not in agent/skills)                       | -    | -          | -               | 2        | 2     | 2026-09-16 | 2026-09-22 | 2        | 167        | 11     | 65.9     | 92    | 5.55     | 0           |            |
| show-me (not in agent/skills)                       | -    | -          | -               | 2        | 2     | 2026-10-20 | 2026-10-21 | 2        | 22         | 0      | 0.0      | 31    | 0.32     | 1659        |            |
| tanstack-ai (not in agent/skills)                   | -    | -          | -               | 2        | 2     | 2026-10-28 | 2026-10-28 | 2        | 350        | 20     | 57.1     | 346   | 19.60    | 0           |            |
| component-mdx (not in agent/skills)                 | -    | -          | -               | 1        | 1     | 2026-09-22 | 2026-09-22 | 1        | 107        | 5      | 46.7     | 53    | 4.00     | 0           |            |
| component-stories (not in agent/skills)             | -    | -          | -               | 1        | 1     | 2026-09-22 | 2026-09-22 | 1        | 107        | 5      | 46.7     | 53    | 4.00     | 0           |            |
| dynamic-resources (not in agent/skills)             | -    | -          | -               | 1        | 1     | 2026-07-01 | 2026-07-01 | 0        | 49         | 2      | 40.8     | 51    | 2.97     | 0           |            |
| effect-v3-to-v4 (not in agent/skills)               | -    | -          | -               | 1        | 1     | 2026-09-18 | 2026-09-18 | 1        | 80         | 0      | 0.0      | 48    | 2.38     | 0           |            |
| local-development (not in agent/skills)             | -    | -          | -               | 1        | 1     | 2026-09-03 | 2026-09-03 | 0        | 236        | 15     | 63.6     | 154   | 22.44    | 0           |            |
| pokemap-pr (not in agent/skills)                    | -    | -          | -               | 1        | 1     | 2026-11-08 | 2026-11-08 | 1        | 75         | 6      | 80.0     | 79    | 1.31     | 0           |            |
| pr-review (not in agent/skills)                     | -    | -          | -               | 1        | 1     | 2026-09-22 | 2026-09-22 | 1        | 107        | 5      | 46.7     | 53    | 4.00     | 0           |            |
| proto (not in agent/skills)                         | -    | -          | -               | 1        | 1     | 2026-11-06 | 2026-11-06 | 1        | 188        | 3      | 16.0     | 180   | 7.99     | 0           |            |
| react-styling (not in agent/skills)                 | -    | -          | -               | 1        | 1     | 2026-09-10 | 2026-09-10 | 0        | 26         | 0      | 0.0      | 8     | 0.32     | 0           |            |
| retro (not in agent/skills)                         | -    | -          | -               | 1        | 1     | 2026-11-03 | 2026-11-03 | 1        | 3          | 0      | 0.0      | 5     | 0.06     | 1101        |            |
| testing (not in agent/skills)                       | -    | -          | -               | 1        | 1     | 2026-09-03 | 2026-09-03 | 0        | 236        | 15     | 63.6     | 154   | 22.44    | 0           |            |

## Facts that matter

- Three links are broken (target does not exist in `~/.agents/skills`): `diagnose`, `stack`, `write-a-skill`. They are symlinks, so this audit did not touch them.
- `grill-me` (157 B) and `grill-with-docs` (247 B) are one-line wrappers that call `grilling` (and `domain-modeling`). They cost almost nothing.
- `to-prd`, `to-spec`, `to-tickets`, `implement-spec`, `decision-mapping`, `stack-and-peel`: zero uses. `to-spec`, `implement-spec`, `to-tickets` are new names (Jul-Oct 2026); `stack-and-peel` is from 2026-11-10 (2 days of data).
- `do-work`, `autonomous-task`, `web-task-e2e-validate` and others in the second table were used a lot but are not in `agent/skills/` now.

## Top 5 by total token cost in history (load tokens)

| #   | skill                 | loads | load tokens | SKILL.md B |
| --- | --------------------- | ----- | ----------- | ---------- |
| 1   | pr-review-triage      | 552   | 1.17 M      | 8849       |
| 2   | create-pr             | 509   | 0.74 M      | 5731       |
| 3   | diagnosing-bugs       | 322   | 0.69 M      | 8530       |
| 4   | codebase-design       | 215   | 0.35 M      | 6446       |
| 5   | refine-branch-commits | 225   | 0.28 M      | 5043       |

Cache reads make later turns cheaper than these raw counts, but the text stays in context for the rest of the session.

## SKILL.md larger than 8 KB (not shortened)

| skill                | bytes | link    | what could move to a file loaded on demand                                                                                                    |
| -------------------- | ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| humanizer            | 30409 | symlink | The pattern catalog (it already has 8 extra files). Keep the workflow and the checklist in SKILL.md. Used 17 times: low value for 30 KB.      |
| fframes-video        | 14672 | symlink | API and render reference. Keep the workflow.                                                                                                  |
| wayfinder            | 12380 | symlink | Ticket templates and examples. 1 use only.                                                                                                    |
| writing-for-agents   | 10886 | symlink | Examples and anti-patterns.                                                                                                                   |
| writing-great-skills | 9414  | symlink | Examples. It overlaps with `writing-for-agents`.                                                                                              |
| slidev               | 8896  | symlink | Feature reference (it already has 54 extra files).                                                                                            |
| pr-review-triage     | 8849  | local   | The `gh` command snippets ("GitHub mutations") and the report template. Top 1 for token cost: best candidate to shorten (it loads 552 times). |
| diagnosing-bugs      | 8530  | symlink | Phase 4 to 6 detail and the non-deterministic section. Top 3 for token cost.                                                                  |

Only `pr-review-triage` is local. The others belong to the shared source.

## Overlap analysis (after reading the files)

| group                                                                        | real overlap?                      | reason                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnose` / `diagnosing-bugs`                                               | Yes, but `diagnose` is a dead link | `diagnose` has no target. `diagnosing-bugs` covers it ("diagnose" is in its description).                                                                     |
| `grill-me`, `grill-with-docs`, `grilling`                                    | No (layered)                       | Wrappers: `grill-me` = `grilling`; `grill-with-docs` = `grilling` + `domain-modeling`.                                                                        |
| `resolve-conflicts` / `resolving-merge-conflicts`                            | Yes                                | Same job. The local one is a longer superset (asks on non-trivial, safe-commit rules). The shared one is 921 B and never aborts.                              |
| `review` / `code-review`                                                     | Partly                             | `review`: one reviewer, pre-PR, clean tree, fix plan. `code-review`: two parallel sub-agents (standards and spec) from a fixed point. Different entry points. |
| `implement` / `implement-spec`                                               | Partly                             | `implement` is a 433 B single-session recipe (tdd, code-review, commit). `implement-spec` runs a task graph of sub-agents. Different scale.                   |
| `to-prd` / `to-spec`                                                         | Yes                                | Same text: a diff after replacing PRD by spec shows only punctuation changes. `to-spec` is the new name.                                                      |
| `to-issues` / `to-tickets`                                                   | Yes                                | Same slicing. `to-tickets` adds blocking edges. `to-tickets` is the new name.                                                                                 |
| `stack` / `stack-and-peel`                                                   | No                                 | `stack` is a dead link.                                                                                                                                       |
| `decision-mapping` / `wayfinder`                                             | Yes                                | Both build a map of decision tickets. `wayfinder` stores it on the issue tracker, `decision-mapping` in a markdown file. Same author line of work.            |
| `handoff`                                                                    | No                                 | Unique. 24 sessions.                                                                                                                                          |
| `improve-codebase-architecture`, `extract-refactorings`, `polish-ui`, `bake` | No                                 | Each is unique. `extract-refactorings` edits commits, `improve-codebase-architecture` reviews design. `bake` and `polish-ui` are specific.                    |

## Decision list

| #   | skill or group                                                                                                                                                                        | recommendation                                                         | note                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `diagnose`, `stack`, `write-a-skill` (broken links)                                                                                                                                   | **Retire**: remove the three dead symlinks                             | Symlinks: the user must decide. No target, no content. Nothing references them by name except the word "diagnose" in a description. |
| 2   | `to-prd`                                                                                                                                                                              | **Retire** (superseded by `to-spec`)                                   | 0 uses. `decision-mapping` mentions `/to-prd`: update it or retire it too.                                                          |
| 3   | `to-issues`                                                                                                                                                                           | **Merge into** `to-tickets` (retire after the move)                    | 12 sessions used `to-issues`. Switch habit to `to-tickets` first.                                                                   |
| 4   | `to-spec`, `to-tickets`, `implement-spec`                                                                                                                                             | **Keep**                                                               | New, 0 uses. `chief-of-staff`, `setup-matt-pocock-skills` and `implement-spec` reference them by name. Check again in 60 days.      |
| 5   | `decision-mapping`                                                                                                                                                                    | **Retire** (use `wayfinder`)                                           | 0 uses, `wayfinder` is the newer superset. `wayfinder` has 1 use and 12 KB: keep, shorten later.                                    |
| 6   | `resolve-conflicts` / `resolving-merge-conflicts`                                                                                                                                     | **Merge into** `resolve-conflicts`; retire `resolving-merge-conflicts` | 202 against 33 sessions. The shared one has the highest error rate here (96 per 1000, small sample).                                |
| 7   | `review` / `code-review`                                                                                                                                                              | **Keep both**; add a cross-reference line                              | Different scope. Merge only if you stop using one: `review` 94 sessions, `code-review` 143.                                         |
| 8   | `grill-me`, `grill-with-docs`, `grilling`                                                                                                                                             | **Keep**                                                               | Wrappers cost less than 250 B.                                                                                                      |
| 9   | `diagnosing-bugs`                                                                                                                                                                     | **Keep**; shorten later                                                | 8.5 KB, top 3 token cost.                                                                                                           |
| 10  | `implement`                                                                                                                                                                           | **Keep**                                                               | 79 sessions, 433 B.                                                                                                                 |
| 11  | `stack-and-peel`                                                                                                                                                                      | **Keep**                                                               | 0 uses but only 2 days old. Not a duplicate. Check again in 60 days.                                                                |
| 12  | `pr-review-triage`                                                                                                                                                                    | **Keep**; shorten                                                      | Top 1 token cost. Move snippets to a referenced file.                                                                               |
| 13  | `humanizer`                                                                                                                                                                           | **Keep or retire** (user choice)                                       | 17 sessions in 5 months, 30 KB. Load tokens are small only because it is rarely used. Move the catalog to a referenced file.        |
| 14  | `writing-great-skills` / `writing-for-agents`                                                                                                                                         | **Merge** (user choice)                                                | Both teach how to write skills. 12 and 28 sessions.                                                                                 |
| 15  | `fframes-video`, `slidev`, `improve-codebase-architecture`, `design-an-interface`, `setup-matt-pocock-skills`                                                                         | **Keep or retire** (user choice)                                       | Rare use (1-9 sessions). Their descriptions may still sit in the system prompt (not verified).                                      |
| 16  | All others (`create-pr`, `codebase-design`, `triage`, `jira`, `bake`, `refine-branch-commits`, `extract-refactorings`, `polish-ui`, `handoff`, `tdd`, `domain-modeling`, `vault-env`) | **Keep**                                                               | Used.                                                                                                                               |

## Applied actions

On 2026-11-13 the user approved decision items 1, 2, 3, 5 and 6. Done: removed these seven symlinks from `agent/skills/` (the shared source in `~/.agents/skills` was NOT touched, so each one can come back with `ln -s`): `diagnose`, `stack`, `write-a-skill` (dead links), `to-prd`, `decision-mapping`, `resolving-merge-conflicts`, `to-issues`. A grep found no skill or doc that names them. `to-tickets` and `resolve-conflicts` remain.

Not applied: items 12 (shorten `pr-review-triage`), 13, 14 and 15 (user choice).

On 2026-11-13 the user decided more:

- Removed the links `slidev` and `writing-great-skills` from `agent/skills/` (shared sources untouched; restore with `ln -s`).
- `humanizer`, `writing-for-agents` (the model reads it by itself in 27 of 28 sessions, so it stays auto-invoked) and `pr-review-triage` stay as they are.
- `fframes-video`: set to manual-only. The shared source `~/.agents/skills/fframes-video/SKILL.md` (not a git repo) got `disable-model-invocation: true` and a one-line description. Its description is now out of the system prompt (about 175 tokens per session saved). Original frontmatter, to restore it:

```yaml
---
name: fframes-video
description: >-
  Create, animate, review and render videos in code with fframes (Rust, SVG scenes, ffmpeg
  encoding, Skia GPU rendering). Use whenever the user wants a video, animation, motion graphic,
  explainer, promo, social clip, title card, podcast visual, lyric/caption video or any rendered
  .mp4/.webm made programmatically, or asks to change, fix, speed up or check an fframes video.
  Covers installing fframes, creating a project, designing good-looking motion, sound (music,
  voice, SFX, loudness), watching it in a real-time preview window, and checking the result
  without watching it: frames and contact sheets as PNG, automatic problem detection, loudness
  numbers, fast draft and range renders.
---
```

Update (2026-11-13, later): the user does not want exclusions in `agent/settings.json`, so they were removed again. Pi also discovers skills in `~/.agents/skills` by itself, so a removed link in `agent/skills/` does not hide a skill from the system prompt. The way used: `disable-model-invocation: true` in the frontmatter of the shared source (not a git repo). It keeps `/skill:name` and removes the description from the prompt. Done for `slidev` and `resolving-merge-conflicts`, checked in a real Pi session. Original frontmatter, to restore:

```yaml
---
name: slidev
description: Create and present web-based slidedecks for developers using Slidev with Markdown, Vue components, code highlighting, animations, and interactive features. Use when building technical presentations, conference talks, code walkthroughs, teaching materials, or developer decks.
---
```

```yaml
---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---
```

Deleted (2026-11-13, user decision): `~/.agents/skills/resolving-merge-conflicts`. It was not in a git repository, so it cannot be restored from git. `resolve-conflicts` replaces it.

Deleted (2026-11-13, user decision): `~/.agents/skills/to-prd`, `to-issues` and `decision-mapping`. They are replaced by `to-spec`, `to-tickets` and `wayfinder`. No other shared skill referenced them. The folder is not in git, so they cannot be restored from git. 40 skills remain.

On 2026-11-13 the user set `humanizer` to manual-only (`disable-model-invocation: true` in the shared source, not in git). Its 300-character description is out of the system prompt. Original frontmatter, to restore:

```yaml
---
name: humanizer
description: |
  Rewrite AI-sounding text so it reads naturally without changing what it says.
  Use when editing or reviewing prose for inflated claims,
  sales language, vague sources, repetitive structure, stock AI words, passive
  voice, filler, or chatbot artifacts. Based on Wikipedia's "Signs of AI writing."
license: MIT
metadata:
  version: "2.11.2"
---
```
