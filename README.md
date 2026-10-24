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

## What preload does

```
drop files
  │
  ├─ stage 0  PARSING       text out of pdf/docx/rtf/md/txt/csv, split on the
  │                         document's own seams. Locators fall out of the
  │                         split: "p.18", "§ Pricing", "00:14:22".
  │                         No model call. Nothing is spent yet.
  │
  ├─ stage 1  READING       one map per document, using the EXISTING extract
  │                         call. Same schema, so nothing can be marked as
  │                         inferred: there is no field for it.
  │
  ├─ stage 2  MERGING       the new work. Exact matches merge with no model.
  │                         Three cheap filters shortlist the rest. Only the
  │                         shortlist is adjudicated.
  │
  ├─ stage 3  STRUCTURING   five to nine areas, graded by how many links they
  │                         cut. Three levels of detail.
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
components/preload/
  Intake  RunProgress  SourceRail  EvidencePanel  PreloadCanvas  ClusterNode
scripts/
  smoke-preload.ts    101 assertions, offline
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
| `ConceptNode.tsx` | contested treatment, source count badge |
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
| `EXTRACT_MODEL` | small and fast. Stage 1 runs it once per section |
| `PROPOSE_MODEL` | stronger |
| `MERGE_MODEL` | defaults to `PROPOSE_MODEL`. The merge is where quality shows |
| `CLUSTER_MODEL` | defaults to `PROPOSE_MODEL` |
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
