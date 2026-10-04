/**
 * The instruction block sent with every question.
 *
 * The lab is being asked for something very specific: an answer a human reads
 * *and* a description the viewer can build a molecule from. A bare question
 * gets prose back, which renders as nothing. So each question travels with the
 * contract it must be answered in.
 *
 * Kept here rather than on the gate so the format and the renderer that
 * consumes it stay in one place: if `result.ts` changes, this changes beside
 * it, and they cannot drift.
 */

import type { AgentResult } from "./result";

/** Raised if the lab answers with something the viewer cannot build. */
export interface ParsedAnswer {
  result: AgentResult | null;
  /** Prose the lab returned outside the JSON block, if any. */
  prose: string;
  /** Why no result could be read, when `result` is null. */
  problem?: string;
}

const FORMAT_BLOCK = `
You are answering a structural biologist who is wearing a headset and looking at
IsPETase (PDB 5XJH, chain A, residues 30-292). Your answer drives both the text
they read and the 3D molecule in front of them.

Reply with your prose answer, then a single fenced JSON block marked \`\`\`json
containing exactly this shape. Everything outside the block is shown as prose;
the block is what builds the molecule.

\`\`\`json
{
  "result_id": "r_<short id>",
  "kind": "mutations | region | comparison | ranking | none",
  "headline": "one line, the first thing they read",
  "summary": "a short paragraph, under 60 words",
  "confidence": 0.0,
  "agent_generated": true,
  "metrics": [
    { "k": "short name", "v": "value with units", "tier": "measured | estimate | lookup | predicted", "warn": false }
  ],
  "citations": [
    { "doc_id": "europepmc:12345678", "title": "...", "year": 2018, "snippet": "the sentence that supports this" }
  ],
  "view": {
    "protein_id": "IsPETase",
    "chain": "A",
    "representation": { "base": "cartoon | surface | backbone | hidden",
                        "color": "gradient | secondary_structure | uniform",
                        "disulfides": false, "termini": false },
    "focus": 160,
    "mutations":  [ { "wt": "S", "pos": 121, "mut": "E", "score": 1.84, "tier": "lookup" } ],
    "highlights": [ { "residues": [121], "role": "mutation | active_site | focus | risk | support | neutral",
                      "label": "short 3D label", "style": "ribbon | sticks | both" } ],
    "links":      [ { "from": 121, "to": 160, "label": "9.3 A", "role": "neutral" } ]
  }
}
\`\`\`

Rules that are not negotiable:

1. Residue numbers must exist in 5XJH chain A, which runs 30-292. A number
   outside that range draws nothing and the answer is wasted.
2. "wt" must be the residue actually at that position in the structure. The
   viewer checks it and flags a mismatch as an error against you.
3. Every claim in "summary" must be supported by a "doc_id" you list. If you
   have no citation for it, do not write it.
4. "tier" is required on every metric. "measured" means it came from data;
   "estimate" means you computed it by addition or assumption; "lookup" means a
   precomputed table; "predicted" means a model said so. Never label an
   estimate as measured.
5. If retrieval found nothing above threshold, answer with kind "none",
   "citations": [], "view": null, and say plainly that there is no evidence.
   Do not improvise an answer. This matters more than being helpful.

Choosing the representation:
  - a question about where something sits in the fold  -> cartoon + gradient
  - a question about a stretch of chain                 -> cartoon + secondary_structure
  - several positions compared at once                  -> cartoon + uniform
  - a pocket, cleft, burial or accessibility            -> surface
  - nothing structural to say                           -> hidden

Use "style": "sticks" on a highlight when the chemistry of the side chain is the
point, and "ribbon" when it is the position along the chain that matters.
`.trim();

/** The full text sent to the lab: the question, then the contract. */
export function buildAgentPrompt(question: string): string {
  return `${question.trim()}\n\n---\n${FORMAT_BLOCK}`;
}

/** The contract on its own, for showing the reviewer what is being attached. */
export function formatSpec(): string {
  return FORMAT_BLOCK;
}

/** Roughly how much of the request is instructions rather than the question. */
export function promptSize(question: string): { question: number; context: number } {
  return { question: question.trim().length, context: FORMAT_BLOCK.length };
}

const RESIDUE_MIN = 30;
const RESIDUE_MAX = 292;

/**
 * Pull a result out of whatever the lab replied with.
 *
 * The lab is a language model at the other end, so this assumes nothing: it
 * finds the JSON block if there is one, and reports plainly when there is not
 * rather than rendering an empty molecule and leaving the reviewer to guess.
 */
export function parseAnswer(text: string): ParsedAnswer {
  const fence = text.match(/```json\s*([\s\S]*?)```/i) ?? text.match(/```\s*(\{[\s\S]*?\})\s*```/);
  const prose = text.replace(/```[\s\S]*?```/g, "").trim();

  if (!fence) {
    return { result: null, prose, problem: "the lab returned no JSON block" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (error) {
    return { result: null, prose, problem: `JSON did not parse: ${(error as Error).message}` };
  }

  const result = parsed as AgentResult;
  if (!result || typeof result.headline !== "string") {
    return { result: null, prose, problem: "JSON block has no headline" };
  }

  // Drop residues outside the deposited range rather than drawing nothing and
  // letting it look like the viewer failed.
  const view = result.view;
  if (view) {
    const inRange = (n: number) => n >= RESIDUE_MIN && n <= RESIDUE_MAX;
    view.mutations = (view.mutations ?? []).filter((m) => inRange(m.pos));
    view.highlights = (view.highlights ?? [])
      .map((h) => ({ ...h, residues: h.residues.filter(inRange) }))
      .filter((h) => h.residues.length > 0);
    view.links = (view.links ?? []).filter((l) => inRange(l.from) && inRange(l.to));
    if (view.focus != null && !inRange(view.focus)) view.focus = null;
  }

  return { result, prose };
}
