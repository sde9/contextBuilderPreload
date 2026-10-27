# Context Builder — Preload

Two modes on one engine.

**Real-time** is the original prototype: someone talks, the map builds, green is
what they said and orange is what the AI guessed.

**Preload** reads a folder of project documents first and hands you the map you
walk into the interview holding. Green is still what was said, except now it was
said in writing, and every green node can show you the sentence, the file and the
page it came from.

Built to `Preload Implementation Standard`, 4 September 2026. Rule numbers in the
code comments (R1 to R14) point back at it.

---

## Start

```bash
rm -rf node_modules          # if this folder was copied from another machine
npm install
npm run env:link                     # once: ties this folder to the Vercel project
npm run dev                          # pulls env from Vercel, then http://localhost:3000
```

The key lives only in the Vercel project settings. `env:pull` writes the
Development variables to `.env.development.local`, which `next dev` reads ahead
of `.env.local`, so `.env.local` is left for local tuning such as
`PROPOSAL_CAP`. `npm run dev` runs `env:pull` first, so a key changed in Vercel
arrives on the next start. If the pull fails (offline, not signed in, not
linked) it says so and dev starts with whatever `.env.development.local` already
holds. A deployed app reads the same variables straight from the project, with
no file at all.

Real-time is at `/`. Preload is at `/preload`. The switch in the header moves
between them.

Check the core with no key and no network:

```bash
npm run smoke:all     # real-time, preload, and the preload server end to end
```

Run that after touching `reducer.ts`, `merge.ts`, `cluster.ts` or `chunk.ts`. It
drives the same code path the model output goes through, using hand-written
patches, so a bad map tells you immediately whether the fault is in the reducer
or in the prompt.

Then check the whole pipeline against real documents. `sample-documents/` holds
four files about the same imaginary project, and the spec and the transcript
disagree about the cancellation window on purpose:

```bash
npm run dev                                        # one terminal
npm run preload sample-documents "Costume rental"  # another
```

That drives the same routes the browser uses and prints the finished map, the
contested nodes with both quotes, the gaps, and how often each guard fired. It
is the fastest way to judge a prompt change, because a printed map is easier to
read than a canvas.

---

## Real-time, Release 1 (21 Oct 2026)

Changes from the test with Gena. Story IDs refer to *CB Real-time Requirements
and User Stories v0.1*.

| Story | What changed for the user | Where |
|---|---|---|
| RT-US-15 | Download, draw.io and Mermaid save a file and leave the page as it was | `lib/download.ts` |
| RT-US-16 | The session is kept in this browser. After a reload a bar offers Restore or Discard. Closing the tab asks first. **Open** loads a downloaded `.context.json` | `lib/persist.ts`, `components/RestoreBar.tsx` |
| RT-US-01 | A session starts with its goal. The goal stays in the header; click it to change it | `components/GoalStart.tsx`, `components/GoalBadge.tsx`, `setGoal` |
| RT-US-02 | Proposals see the goal and the whole conversation (up to 40,000 characters), not only the last 3 statements | `contextPayload`, `proposeUser`, `PROPOSE_REALTIME_RULES` |
| RT-US-03 | At most 2 new questions per turn (`NEXT_PUBLIC_QUESTION_CAP`), each with a line on why it matters. Dismissed questions are never asked again | `applyPropose` options, `ProposePatchRT` |
| RT-US-04 | A proposal whose words were all just said is dropped as an echo | `saidThisTurn` in `lib/guards.ts` |
| RT-US-17 | **Picture**, next to Tidy up, saves the whole map as a PNG | `lib/snapshot.ts` |

Every proposal and extract log entry now records the model, time and tokens
(`log[].meta`), so the cost of a session can be read from its file.

Preload is unchanged: the new prompt rules and schema fields are Real-time
variants that the pipeline does not use, and `applyPropose` behaves as before
when it is called without options.

---

## Answers on the map, both modes (26 Oct 2026)

A question box used to offer only Confirm and Reject, which does not fit a
question. Now it takes an answer, in Real-time and in Preload alike.

| What changed for the user | Where |
|---|---|
| A question box has an answer field with **Answer** (or Cmd+Enter) and **Dismiss**. Confirm and Reject stay on the AI's other guesses only | `ConceptNode.tsx` (`AnswerBox`) |
| The answer is read against the map, and the map changes to match it: what the answer states lands green and cites the answer; a label or note it corrects is changed, with the old wording kept in the log; an orange guess it confirms turns green, one it denies is rejected. A green concept is never thrown out by an answer, only corrected | `ANSWER_SYSTEM`, `AnswerPatch`, `applyAnswer` |
| Something new the answer leaves unconnected is tied to the concept the question was about | `applyAnswer` |
| A question the answer settles leaves the map and keeps its answer in the file. "Not sure" or half an answer is still recorded, and the box stays with a line saying so | `answersQuestion` |
| Real-time: after an answer, the usual proposal call runs, and it is told which questions are answered so it does not ask them again | `answerQuestion` in `lib/store.ts`, `contextPayload.answeredQuestions` |
| Preload: the answer is saved to the run like any other decision. The evidence panel shows it as "answer to ...", and the questions panel lists what was answered | `api/preload/act` (`answer`), `EvidencePanel`, `QuestionsPanel` |

The answer call uses `ANSWER_MODEL`, then `EXTRACT_MODEL`, then Haiku 4.5.
Each answer is logged with its model, time and tokens. `PROMPT_VERSION` is
`p6-2026-10-26`.

**27 Oct: the right panel and Later.** Every question, on the map or in the
right panel, has the same answer field, plus **Later** and **Dismiss**. Later
takes a box off the map, or a list question out of the open list, into a
**Later** section of the panel. From there it can be answered or sent back.
A Later question stays open for the AI, so it is not asked again, and the
open-list cap never retires it. In Preload, Later on a box keeps it in the
questions to ask, and every question in the questions panel can be answered.
Where: `components/AnswerField.tsx`, `GapBar.tsx`, `parkQuestion`,
`unparkQuestion`, `laterQuestions`, `answerTarget` in `lib/reducer.ts`.

Since 27 Oct the live session keeps its questions as records, drawn as cards
(Release 2, below). Preload still uses question boxes and list items.

---

## Real-time, Releases 2 to 4 (27 Oct 2026)

Story IDs refer to *CB Real-time Refinements v0.1*. Preload is unchanged: every
new option is passed only by the live store, and the new prompt rules and
schema fields are Real-time variants.

### Release 2: one question

| Story | What changed for the user | Where |
|---|---|---|
| RT-US-06 | A question is a **card** under the map, not a box in it. A dashed line runs from the concept it is about. Dagre never sees cards, so a question never pushes the map around. At most 5 cards; a new question past that waits in the panel | `QuestionNode.tsx`, `Canvas.tsx`, `applyPropose` option `questionsAsRecords`, `MAX_QUESTIONS_ON_MAP` |
| RT-US-07 | **Answer** on a card is read against the map (the same answer call as before). The next proposals stay with what the question was about and what the answer added | `answerQuestion` in `lib/store.ts`, `applyPropose` option `focusIds`, FOCUS block in `proposeUser` |
| RT-US-08 | An answer typed in the main input closes the question it clearly answers. The extract call sees the open questions and names the ones answered, by id only | `ExtractPatchRT.answersQuestionIds`, `EXTRACT_REALTIME_RULES`, `applyExtract` |
| RT-US-09 | The right panel is **Open questions (n)**: every question put off with Later or waiting for room on the map. Each can be answered, sent **Back to map** or dismissed. The subject is a link that brings it into view and highlights it | `OpenQuestionsPanel.tsx` (was `GapBar.tsx`), `focusConcept` |
| RT-US-10 | A concept with questions waiting in the panel shows **★n** | `parkedCountByAnchor`, `ConceptNode` `parkedQuestions` |
| RT-US-11 | Confirm and Reject stay on guesses only. A session restored or opened from before Release 2 has its question boxes turned into cards (same ids, answers kept) | `migrateQuestionConcepts`, run on Restore and Open only |

Question states are read from markers, not stored in `status`: OPEN, PARKED
(`parkedAt`), ANSWERED (`answeredAt`), DISMISSED (`dismissedAt`), DROPPED
(`droppedAt`). `status` stays `OPEN` or `DONE`, because Preload counts
`status === 'OPEN'` and files from 26 Oct already carry the markers. See
`questionState` in `lib/types.ts`.

### Release 3: Finish

| Story | What changed for the user | Where |
|---|---|---|
| RT-US-12 | **Finish** in the header (from turn 1) opens three steps. Review lists every open question, unticked. Ticked ones are kept for next time; the rest are dropped and never asked again. **Back to session** closes it at any step | `FinishPanel.tsx`, `applyFinishReview`, `Model.wrapup` |
| RT-US-13 | Up to 5 topics for the next conversation, from the goal, the confirmed map and the kept questions. Each can be removed. If the call fails: "No topics this time" | `app/api/wrapup`, `WRAPUP_SYSTEM`, `WrapupPatch`, `setWrapupTopics` |
| RT-US-14 | **Download report**: one HTML file (goal, what we covered, open questions, topics, the map as a picture) that prints to A4. "What we covered" is built from the data, not by the AI, and nothing rejected appears in it | `lib/report.ts` |
| RT-US-18 | The start screen shows how a session goes in four steps, and what the colours mean | `StartSteps` in `app/page.tsx` |

### Release 4: options

| Story | What changed | Where |
|---|---|---|
| RT-US-19 | **Links** in the header hides the links on screen. Boxes stay where they are; the file keeps every link | `showLinks` |
| RT-US-05 | Models that refuse a forced tool (Opus 5.5, Sonnet 5.5, Fable, Mythos) are asked through structured outputs (`output_config.format`) instead. `ANTHROPIC_OUTPUT_MODE=json` does the same for any model | `outputModeFor`, `callAnthropicJson` in `lib/llm.ts` |

To try the stronger model, set `PROPOSE_MODEL=claude-opus-5-5` in the Vercel
Preview environment, together with `ANTHROPIC_API_KEY` (Preview has none yet).

### Fixed on the way: the map was not laid out after a turn

The live canvas is a controlled React Flow and wrote back only drags. React
Flow reports each box's size as a change, and a controlled canvas has to hand
it back on the node. Without it, every model change made unmeasured nodes:
boxes flickered hidden until measured again, `nodesInitialized` stayed false,
and the layout effect never passed its checks. So the "layout after every
turn" decision of 18 Aug was not running, and Tidy up ranked every box at its
default size. `Canvas.tsx` now keeps the sizes and passes them back.

Also: the OpenAI path now treats `finish_reason: length` as a cut-off answer
and retries it bigger, as the Anthropic path does.

`PROMPT_VERSION` is `p7-2026-10-27`. Checks: `smoke` has 66 new checks (176 in
all); `smoke:preload` and `smoke:store` are unchanged and pass.

---

## Preload, 25 Oct 2026: the document's own structure

Changes after the first real chapter went through. A map of a Word chapter came
out as a flat list of boxes in one grey area: correct, and no help in
understanding the chapter.

| What changed for the user | Where |
|---|---|
| A Word file keeps its headings (by style, by numbering like "5.5", or "Chapter 5"), lists and tables. Tables of contents and deleted revisions are left out. A PDF keeps paragraphs, finds headings by font size, mends words broken at a line end and drops running headers and page numbers | `lib/parse.ts` |
| Each document is read top down first. One outline call finds the main point and the parts in reading order, each with a quote. A quote found in the text makes the box green; a quote that is not there makes it orange | `lib/outline.ts`, `OUTLINE_SYSTEM`, stage 1 |
| With one document read, the map is its outline: the main point on top, one row per part, the part's details to its right. Overview shows the main point and the parts; double-click a part to open it | `structureFromOutline`, `layoutByParts` |
| A detail's link to its part runs down to a rail under its row and along it, so no line passes behind another box. The label sits just under the detail it belongs to | `routeOutlineLink` |
| The slider under the map replays it step by step. **Logic**: the main point, each part with its details, then the AI's guesses. **As written**: in the order the documents say it. Steps still to come are pale outlines, so the shape of the whole map is there from the first step | `lib/story.ts`, `StoryBar` |
| A section the model could not read is tried again in two halves. If it still fails, the source names the sections that were not read. Before, they disappeared without a word | `readSource`, `SourceRail` |
| Two concepts from one document can now merge. Two parts of one document never do | `shortlistPairs` |
| A new kind, `CLAIM`: a statement the document argues for, with its verdict first | `types.ts`, `ExtractPatchPL` |
| One silhouette per kind (thing box, detail chip, who pill, step arrow, rule plate, claim with a bar, question bubble, problem with a red top), size for importance, plain words on the tags, and the same legend on both pages | `ConceptNode.tsx`, `ShapeLegend.tsx` |
| The open questions pill opens the questions to ask. Save a question the map raised, dismiss it, or write your own. The saved list stays with the run and leaves as Markdown or on the clipboard | `QuestionsPanel`, `api/preload/act` |

With several documents the map is still built by areas, as before; the outline
of each one is still read, because it tells the extract call what each section
is part of. `PROMPT_VERSION` is `p5-2026-10-25`.

---

## What preload does

```
drop files
  │
  ├─ stage 0  PARSING       text out of pdf/docx/rtf/md/txt/csv, split on the
  │                         document's own seams. Locators fall out of the
  │                         split: "p.18", "§ Pricing", "00:14:22".
  │                         No model call. Nothing is spent yet.
  │
  ├─ stage 1  READING       one outline call per document: the main point and
  │                         the parts, each with a quote that is checked
  │                         against the text. Then one map per document,
  │                         using the EXISTING extract call section by
  │                         section. A failed section is tried in two halves.
  │
  ├─ stage 2  MERGING       the new work. Exact matches merge with no model.
  │                         Three cheap filters shortlist the rest. Only the
  │                         shortlist is adjudicated.
  │
  ├─ stage 3  STRUCTURING   one document: its outline. Several: five to nine
  │                         areas, graded by how many links they cut. Three
  │                         levels of detail either way.
  │
  └─ stage 4  PROBING       what the whole corpus never says.
```

Each stage is one HTTP request, so the progress screen reports things that
actually happened rather than animating a bar. A run lives in shared storage
(the project's private Vercel Blob store when deployed, `.runs/` locally), so a
closed laptop does not lose it and `?run=<id>` reopens it from any device.

### The merge

This is where the value is and where a mistake is expensive.

| Outcome | What happens | Review |
|---|---|---|
| exact match | one node, evidence from both files | applies silently |
| `SAME` | one node, marked merged, Split available | applies, reversible |
| `RELATED` | both nodes stay, one orange link added | applies, reversible |
| `CONFLICT` | one `CONTESTED` node holding both quotes | waits for a person |

Shortlisting runs three filters before the model sees anything: same normalised
label, near label by trigram overlap, and shared neighbour. The third is the one
that earns its keep. "Hire period" in the spec and "rental window" in the
transcript share no words, and they both attach to Booking.

`MergePatch` carries two existing ids, a verdict, and a label that must equal one
of the two inputs. There is no field for a new concept. The reducer enforces it
rather than trusting it: an unknown id is dropped and `invented` goes up.

### Contested nodes

Two documents that disagree produce one node with a hatched red fill and a `≠`
badge, holding both readings with their citations. Nothing is chosen
automatically. Clicking it offers three answers, and none of them delete the
losing quote: it stays in the file with its source.

---

## New files

```
lib/
  chunk.ts        splitting on document seams, locators, role guessing   PURE
  merge.ts        shortlist, applyMerge, split, resolveContest           PURE
  cluster.ts      areas, tiers, crossing check, coverage                 PURE
  outline.ts      the outline: quotes checked, parts, levels             PURE
  story.ts        the steps behind the slider                            PURE
  parse.ts        pdf/docx/rtf/text to text                       server only
  pipeline.ts     the five stages                                 server only
  runStore.ts     a run in Blob or on disk, one key per piece      server only
  intake.ts       stage 0 for one uploaded file                   server only
  limits.ts       upload limits, shared by browser and server
  preloadStore.ts the preload client
app/
  preload/page.tsx
  api/preload/run              a new empty run, and the list of runs
  api/preload/run/[id]         reopen a run
  api/preload/run/[id]/files   stage 0, one file per request
  api/preload/step             one unit of work
  api/preload/health           is there a store? ?probe=1 writes and reads one
  api/preload/act    confirm, reject, split, resolve, role
components/
  ShapeLegend.tsx     what the shapes mean, on both pages
components/preload/
  Intake  RunProgress  SourceRail  EvidencePanel  PreloadCanvas  ClusterNode
  StoryBar  QuestionsPanel
scripts/
  smoke-preload.ts    193 assertions, offline
  smoke-store.ts      every preload route, a fake model, memory and disk stores
  run-preload.mjs     drive a whole run from the command line
sample-documents/     four files with one deliberate contradiction
```

`merge.ts`, `cluster.ts` and `chunk.ts` have no React, no network and no side
effects, exactly like `reducer.ts` and `guards.ts`. That is why the whole merge
was written and proven before a single provider call existed.

## Changed, and why

| File | Change |
|---|---|
| `types.ts` | `CONTESTED` status. Four fields on `Concept`. Three counters on `Blocked`. `Source`, `Chunk`, `Excerpt`, `Cluster`, `Run`. |
| `reducer.ts` | `applyExtract` takes an optional written-evidence record. With it, the evidence lands in `excerpts` instead of `statements`. Nothing else in the function changes, because `evidence[]` always held ids. |
| `guards.ts` | untouched |
| `schema.ts` | `ExtractPatch` untouched. `MergePatch` and `ClusterPatch` added. |
| `prompts.ts` | `EXTRACT_SYSTEM` untouched. Preload changes the user message, never the system prompt. |
| `place.ts` | untouched, and unused by preload |
| `ConceptNode.tsx` | contested treatment, source count badge. Since 25 Oct: one silhouette per kind, plain-word tags, the main point and parts drawn larger, handles on all four sides, and Confirm and Reject passed in by the page that draws it |
| `ConceptEdge.tsx` | since 25 Oct: a label can sit near one end, a link can follow a route worked out from the layout, and a link still to come on the slider is faint |
| `export.ts` | contested survives into draw.io and Mermaid |

The original 20 smoke assertions pass unchanged.

---

## Configuration

Set in the Vercel project (Settings → Environment Variables) and fetched
locally with `npm run env:pull`. Anything in `.env.local` applies on top for
this machine only:

| Variable | Notes |
|---|---|
| `LLM_PROVIDER` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | one of them, server side only |
| `ANTHROPIC_OUTPUT_MODE` | `tool` (default) or `json`. Opus 5.5, Sonnet 5.5, Fable and Mythos always use `json` |
| `NEXT_PUBLIC_QUESTION_CAP` | new questions per live turn, default 2 |
| `EXTRACT_MODEL` | small and fast. Stage 1 runs it once per section |
| `PROPOSE_MODEL` | stronger |
| `MERGE_MODEL` | defaults to `PROPOSE_MODEL`. The merge is where quality shows |
| `CLUSTER_MODEL` | defaults to `PROPOSE_MODEL` |
| `OUTLINE_MODEL` | the outline call, once per document. Defaults to `PROPOSE_MODEL` |
| `PROPOSAL_CAP` | orange nodes per pass, default 8 in preload |
| `BLOB_READ_WRITE_TOKEN` | set by Vercel when a Blob store is connected to the project. Runs go there |
| `PRELOAD_RUN_DIR` | keep runs in this folder instead. Default `.runs` when running locally |

---

## Deploying

It runs on Vercel, and needs two things set up in the project first.

**Set the environment variables in the project settings.** `.env.local` is not
in this repository, so a fresh deployment has no key. At minimum:
`LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `EXTRACT_MODEL`, `PROPOSE_MODEL`.

**Connect a private Blob store.** Storage → Create → Blob, access Private,
region iad1, connected to Production, Preview and Development. Vercel then sets
`BLOB_READ_WRITE_TOKEN` and runs go there. Without a store a deployment refuses
to start a run and says what to connect, because the only disk a function has
is its own temporary one. Each route is a separate function with its own
`/tmp`, so a run saved by the upload was never visible to the step that reads
it; that is why Preload did not work on Vercel before 24 October 2026.
`/api/preload/health?probe=1` writes one small object and reads it back.

Layout in the store, the same on disk:

```
runs/<id>/run.json               the model without chunk text
runs/<id>/chunks/<sourceId>.json one file's sections, written once at upload
runs/<id>/docs/<sourceId>.json   one file's own map from stage 1
```

Blobs are private and read with `useCache: false`, so a step always sees what
the previous request wrote. The uploaded files themselves are not kept, only
their text, split into sections. Nothing deletes a run yet: the text of every
uploaded document stays in the store until someone removes it in the Vercel
dashboard. Agree retention with the product owner before real client
documents go in (OQ-07).

**Uploads are one file per request, 4 MB each.** Vercel refuses a function
request body over 4.5 MB before any code runs, so the browser creates the run
first and then sends the files one by one. A bigger file is named on screen and
skipped. The limit is the same locally.

---

## Not in this version

No OCR, so a scanned PDF is named as a scan and skipped rather than guessed at.
No images. No re-running one changed document into a finished map. No sharing,
and no second person on the same run. Hand editing beyond confirm, reject, split
and resolve is not wired up yet, though `origin: USER` is written by the ones
that are.

Each of those is a separate decision. None of them changes anything above.
