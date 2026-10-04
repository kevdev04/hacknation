# Contract — `POST /api/v1/ask`

For whoever implements the voice fast path on `ar_vr_bridge`.

This finishes the endpoint already sketched in
[`docs/API.md`](https://github.com/joseraulsoriano/hack-databricks/tree/main/docs)
as *"camino rápido para la voz ⏳ todavía no implementado"*. Nothing here
contradicts that sketch; it fills in the parts a client cannot guess.

**Source of truth for the shapes is `ar_vr_bridge/contract.py`.** `Citation`
below is that class, unchanged. If it changes there, it changes here.

---

## Why this endpoint exists

The VR headset captures a spoken question. Quest Browser has **no Web Speech
API** (verified on device: no `SpeechRecognition`, prefixed or not, and no
`speechSynthesis`), so audio is recorded in the browser and transcribed
server-side. What arrives here is already text.

```
Quest Browser ──audio──> Gate API ──Whisper──> text
                                                 │
                                                 ├──> POST /api/v1/ask      ← this doc, < 1.5 s
                                                 └──> WS  /ws/explore       ← exists, 9-13 s
```

The two paths are independent and may be fired together. `/ws/explore` already
accepts a `query` string and **works today** — if all you want is the full loop,
nothing new is needed. This endpoint exists because the full loop takes 9-13 s
and a spoken question cannot wait that long for an answer.

---

## Request

```
POST /api/v1/ask
Content-Type: application/json
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | The transcript, as spoken. 1-500 chars. Do not assume punctuation or casing — it comes from a speech model |
| `num_results` | int | no | Passages to retrieve. Default 5, cap 10 |
| `query_id` | string | no | Supplied so one spoken question can be correlated with a parallel `/ws/explore` run. Generate `q_<8 hex>` when absent |
| `language` | string | no | BCP-47, e.g. `en`, `es`. Hint for the answer language. Default: answer in the language of `query` |

```json
{ "query": "what raises PET hydrolase thermostability", "num_results": 5 }
```

---

## Response — 200

```json
{
  "schema_version": "1.0",
  "query_id": "q_8f2c",
  "answer": "Assay temperature explains more variance in activity than sequence composition…",
  "tts_text": "Temperature matters more than composition. Joo 2018 and Norton-Baker 2025 both support this.",
  "citations": [
    {
      "id": "c1",
      "doc_id": "europepmc:29374183",
      "title": "Structural insight into molecular mechanism of PET degradation",
      "authors_short": "Joo et al.",
      "year": 2018,
      "doi": "10.1038/s41467-018-02881-1",
      "url": "https://europepmc.org/article/MED/29374183",
      "source": "europepmc",
      "snippet": "The narrow active site cleft accommodates the aromatic substrate.",
      "score": 0.83
    }
  ],
  "latency_ms": 940,
  "has_evidence": true
}
```

| Field | Type | Notes |
|---|---|---|
| `schema_version` | string | `SCHEMA_VERSION` from `contract.py` |
| `query_id` | string | Echoed, or generated |
| `answer` | string | Full prose answer. Shown on the panel |
| `tts_text` | string | **≤ 40 words.** Spoken aloud. Must stand alone without the citations |
| `citations` | `Citation[]` | Exactly the `Citation` model in `contract.py`. May be empty |
| `latency_ms` | int | Measured server-side, first byte |
| `has_evidence` | bool | See below. This field is load-bearing |

### `has_evidence` is the important one

`false` when retrieval returns nothing above the similarity threshold.

When it is `false` the client says *"no evidence in the corpus"* and **does not
read `answer` aloud**. So in that case:

- `answer` and `tts_text` must say there is no evidence, not improvise one
- `citations` must be `[]`

This is the line between this system and a general chatbot, and it is the thing
the challenge's rigor criterion is actually checking. A fluent answer with no
citation is worse than no answer.

Every claim in `answer` must be traceable to a `doc_id` in `citations`.

---

## Errors

| Status | When | Body |
|---|---|---|
| `422` | `query` missing or empty | FastAPI's default validation body |
| `503` | Vector index or embedding endpoint unreachable | `{"detail": "..."}` |
| `504` | Retrieval exceeded the budget | `{"detail": "..."}` |

Prefer a `200` with `has_evidence: false` over a `5xx` whenever retrieval simply
found nothing — that is a valid result, not a failure.

---

## Budget

**1.5 s to first byte.** That is the whole reason this is not `/ws/explore`.

If you cannot hold it, cut `num_results` before you cut answer quality. The
client treats anything past 5 s as a timeout and falls back to showing the
transcript alone.

Streaming is welcome but optional: `text/event-stream` lets the text reach
text-to-speech as it is generated. If you stream, keep the same field names and
send `citations` in the final event. The client handles both.

---

## Data source

Per `docs/CURACION.md`:

| | |
|---|---|
| Index | `workspace.lab.rag_v0_idx` → `rag_v1_idx` once curation lands |
| Endpoint | `lab-vs` (already ONLINE) |
| Embeddings | `databricks-gte-large-en` |
| Key | `chunk_id` |

Swapping `v0` → `v1` is a config line. The client never sees it.

---

## Things the client needs that are easy to miss

1. **CORS.** The headset loads the viewer from a different origin. `ar_vr_bridge`
   already sets `allow_origins=["*"]`; keep that on this route.
2. **HTTPS.** WebXR requires a secure context, so the deployed host must be
   `https://`. A mixed-content call from an HTTPS page to an HTTP API is blocked
   by the browser.
3. **No auth header today.** If you add one, say so — the key would have to live
   on the gate, never in the frontend.
4. **Language.** Transcripts arrive in whatever the reviewer spoke. The corpus is
   English; answering in the asked language is preferred, but say so if you only
   support English.

---

## Done when

```bash
curl -s -X POST "$BASE/api/v1/ask" \
  -H 'Content-Type: application/json' \
  -d '{"query":"what raises PET hydrolase thermostability","num_results":5}'
```

returns in **under 1.5 s**, with `has_evidence: true`, a `tts_text` of 40 words
or fewer, and at least one citation carrying a resolvable `url`.

And this returns `has_evidence: false` with an empty `citations`, rather than a
confident paragraph:

```bash
curl -s -X POST "$BASE/api/v1/ask" \
  -H 'Content-Type: application/json' \
  -d '{"query":"what is the ticket price for the moon"}'
```

---

# Seeing what was asked

A question is currently not stored anywhere. It arrives over `/ws/explore`,
drives one run, and is gone — it lives only in the gate's in-memory run list and
does not survive a restart. Grepping `ar_vr_bridge/` for `INSERT`, `MERGE`,
`write` or `save` returns nothing, and the one Databricks call in the repo is a
`SELECT` against `documents_staging` with a hardcoded `'%PET%'` filter that
never sees the question.

This section specifies persisting it.

## Table — `workspace.lab.queries`

| Column | Type | Null | Notes |
|---|---|---|---|
| `query_id` | STRING | no | Primary key. `q_<8 hex>`, the id the run already uses |
| `query` | STRING | no | The text exactly as received. Do not clean or re-case it — a transcript's rough edges are evidence about the speech model |
| `source` | STRING | no | `voice` \| `text` \| `agent` |
| `asked_by` | STRING | yes | Reviewer id, from the gate's `?reviewer=` |
| `asked_at` | TIMESTAMP | no | UTC, set server-side on receipt |
| `mode` | STRING | no | `live` \| `mock` — so simulated runs are never mistaken for real ones |
| `language` | STRING | yes | BCP-47 if the client sent one |
| `answered` | BOOLEAN | no | False on insert, true when the run completes |
| `verdict` | STRING | yes | `PASS` \| `WARN` \| `FAIL`, from `Validation` |
| `has_evidence` | BOOLEAN | yes | For `/api/v1/ask` |
| `latency_ms` | INT | yes | Filled on completion |
| `citation_doc_ids` | ARRAY<STRING> | yes | The `doc_id`s actually cited |
| `error` | STRING | yes | Set when the run failed |

## When to write

**Insert on receipt, before the run starts** — `answered = false`, nothing else
filled in. Update that row when the run finishes.

This ordering is the point. Write only on completion and a question that crashed
the lab leaves no trace, which is exactly the question you most want to see. A
row still at `answered = false` an hour later is a failure you can find.

Applies to all three entry points: `WS /ws/explore`, `POST /api/v1/explore`,
`POST /api/v1/ask`.

## Reading them back — `GET /api/v1/queries`

| Param | Type | Notes |
|---|---|---|
| `limit` | int | Default 50, cap 500 |
| `since` | ISO-8601 | Only rows with `asked_at` after this |
| `asked_by` | string | Filter to one reviewer |
| `unanswered` | bool | Only `answered = false` — the failures |

```json
{
  "count": 2,
  "queries": [
    { "query_id": "q_3c1d5012", "query": "Hola, es una prueba de voice to text.",
      "source": "voice", "asked_by": "kevin", "asked_at": "2026-10-03T23:41:02Z",
      "mode": "mock", "answered": true, "verdict": "WARN",
      "has_evidence": true, "latency_ms": 9000,
      "citation_doc_ids": ["europepmc:29374183"], "error": null }
  ]
}
```

## Done when

Ask a question from the headset, then:

```sql
SELECT query_id, query, source, asked_by, asked_at, answered, verdict
FROM workspace.lab.queries
ORDER BY asked_at DESC
LIMIT 10;
```

returns it, with `query` matching the transcript word for word. And killing the
lab mid-run leaves a row with `answered = false` rather than no row at all.
