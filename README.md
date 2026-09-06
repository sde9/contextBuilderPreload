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
cp .env.local.example .env.local     # paste one API key
npm run dev                          # http://localhost:3000
```

Real-time is at `/`. Preload is at `/preload`. The switch in the header moves
between them.

Check the core with no key and no network:

```bash
npm run smoke:all     # 20 real-time assertions + 101 preload assertions
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

## What preload does

```
drop files
  │
  ├─ stage 0  PARSING       text out of pdf/docx/md/txt/csv, split on the
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
actually happened rather than animating a bar. A run lives on disk under
`.runs/`, so a closed laptop does not lose it and `?run=<id>` reopens it.

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
  parse.ts        pdf/docx/text to plain text                     server only
  pipeline.ts     the five stages                                 server only
  runStore.ts     a run on disk                                   server only
  preloadStore.ts the preload client
app/
  preload/page.tsx
  api/preload/run    stage 0, and reopening a run
  api/preload/step   one unit of work
  api/preload/act    confirm, reject, split, resolve, role
components/preload/
  Intake  RunProgress  SourceRail  EvidencePanel  PreloadCanvas  ClusterNode
scripts/
  smoke-preload.ts    101 assertions, offline
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

`.env.local`:

| Variable | Notes |
|---|---|
| `LLM_PROVIDER` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | one of them, server side only |
| `EXTRACT_MODEL` | small and fast. Stage 1 runs it once per section |
| `PROPOSE_MODEL` | stronger |
| `MERGE_MODEL` | defaults to `PROPOSE_MODEL`. The merge is where quality shows |
| `CLUSTER_MODEL` | defaults to `PROPOSE_MODEL` |
| `PROPOSAL_CAP` | orange nodes per pass, default 8 in preload |
| `PRELOAD_RUN_DIR` | where runs are stored. Default `.runs` locally, `/tmp/preload-runs` on serverless |

---

## Deploying

It runs on Vercel with no changes, and two things are worth knowing first.

**Set the environment variables in the project settings.** `.env.local` is not
in this repository, so a fresh deployment has no key. At minimum:
`LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `EXTRACT_MODEL`, `PROPOSE_MODEL`.

**Runs are only as durable as the instance.** A serverless deployment has a
read-only filesystem apart from `/tmp`, so that is where runs go. `/tmp` belongs
to one instance and is wiped on a cold start. Driving a run step after step
keeps hitting the same warm instance and finishes normally, but a long pause in
the middle can lose it, and the map will not reopen tomorrow from its `?run=`
link.

For a demo that is fine. To make R4 true in a deployment, point
`PRELOAD_RUN_DIR` at a mounted volume, or replace the four functions in
`runStore.ts` with a real store. They are the only place that touches a disk.

---

## Not in this version

No OCR, so a scanned PDF is named as a scan and skipped rather than guessed at.
No images. No re-running one changed document into a finished map. No sharing,
and no second person on the same run. Hand editing beyond confirm, reject, split
and resolve is not wired up yet, though `origin: USER` is written by the ones
that are.

Each of those is a separate decision. None of them changes anything above.
