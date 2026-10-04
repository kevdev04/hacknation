/**
 * What the agent lab sends back when a run finishes.
 *
 * One object serves two consumers, which is why it is shaped the way it is:
 *
 *   - the right-hand panel renders `headline`, `summary`, `metrics`, `citations`
 *   - the molecule in the middle is driven entirely by `view`
 *
 * `view` is deliberately written in the vocabulary of the *structure*, not of
 * the renderer: residue numbers, roles, links. The backend never picks a colour
 * or a camera angle — it says what a residue means and the viewer decides how
 * that looks. That keeps the contract stable while the visuals change.
 *
 * How a highlight is drawn:
 *
 *   - the **cartoon ribbon itself is repainted** for every highlighted residue,
 *     so the molecule changes rather than gaining a second model on top of it
 *   - **side chains are drawn as sticks** only where the chemistry is the point:
 *     the catalytic triad, anything flagged `risk`, single residues, and every
 *     modelled mutation. A six-residue loop is recoloured, not sprouted.
 *
 * Set `style` on a highlight to override that choice.
 *
 * Every number carries its `tier`, because this project does not let a modelled
 * value and a measured one look alike.
 */

export type ResultKind =
  | "mutations" // one or more specific substitutions proposed
  | "region" // a stretch of the protein worth attention, no specific mutation
  | "comparison" // two or more variants set against each other
  | "ranking" // an ordered shortlist
  | "none"; // the lab found nothing it would stand behind

/** How a number was arrived at. Never collapse these in the UI. */
export type Tier = "measured" | "estimate" | "lookup" | "predicted";

/**
 * What a residue means, not what colour to paint it.
 *
 * `active_site` and `risk` get their side chains drawn by default, because a
 * reviewer judging them needs to see the chemistry. The rest are ribbon-only
 * unless the highlight names a single residue.
 */
export type Role = "mutation" | "active_site" | "focus" | "risk" | "support" | "neutral";

/** How a highlight should be represented, when the default is not what you want. */
export type HighlightStyle =
  | "ribbon" // repaint the cartoon only
  | "sticks" // side chains only, ribbon left alone
  | "both"; // repaint and draw side chains

export interface Highlight {
  residues: number[];
  role: Role;
  /** Short text for the 3D label. Omit for no label. */
  label?: string;
  /** Longer text, shown in the panel rather than in the scene. */
  detail?: string;
  /**
   * Overrides the viewer's default. Without it: `both` for `active_site`,
   * `risk`, or a highlight of one or two residues; `ribbon` otherwise.
   */
  style?: HighlightStyle;
}

/** A line drawn between two residues — a distance, a contact, a risk pair. */
export interface Link {
  from: number;
  to: number;
  label?: string;
  role?: Role;
}

/**
 * A substitution to model. The backbone is kept from the measured structure and
 * the side chain is rebuilt from a rotamer library, so the residue is drawn as
 * the amino acid it would become — not as a marker on the wild type.
 */
export interface MutationSpec {
  wt: string;
  pos: number;
  mut: string;
  /** Optional per-mutation number, with its provenance. */
  score?: number;
  tier?: Tier;
}

/**
 * The base model the whole protein is drawn as.
 *
 * Pick it from what the answer is *about*, not from what looks impressive:
 *
 *   cartoon   the fold — helices, strands, loops. The default, and right for
 *             almost every question about where something sits in the structure
 *   surface   shape and pockets — use when the answer is about a cleft, a
 *             binding site, accessibility or burial. Hides the interior, so a
 *             side chain inside it cannot be seen
 *   backbone  a plain trace. Quieter than cartoon when many residues are
 *             highlighted at once and the ribbon would compete with them
 *   hidden    no protein. For an answer with nothing structural to say
 */
export type BaseModel = "cartoon" | "surface" | "backbone" | "hidden";

/**
 * How the base is coloured where no highlight overrides it.
 *
 *   gradient             N-terminus to C-terminus. Shows chain direction
 *   secondary_structure  helix / strand / loop, as a textbook figure
 *   uniform              one muted colour, so highlights carry all the meaning
 */
export type ColorScheme = "gradient" | "secondary_structure" | "uniform";

export interface Representation {
  base: BaseModel;
  color: ColorScheme;
  /**
   * Draw disulfide bonds as sticks. Detected from the structure (SG-SG under
   * 2.5 Å), never declared by the backend — in 5XJH these are Cys203-Cys239
   * and Cys273-Cys289.
   */
  disulfides?: boolean;
  /** Label the N and C termini. */
  termini?: boolean;
  /** 0-1, only when `base` is "surface". Below ~0.6 the interior stays visible. */
  surface_opacity?: number;
}

export interface ResultView {
  protein_id: string;
  chain: string;
  /** Omit to accept the default for this result's `kind`. */
  representation?: Representation;
  /** Residue to centre attention on. The viewer may frame or mark it. */
  focus?: number | null;
  /** Substitutions to model on the backbone. Drives side-chain rebuilding. */
  mutations?: MutationSpec[];
  highlights?: Highlight[];
  links?: Link[];
}

export interface Metric {
  /** Short name, e.g. "ΔTm" or "macro-F1". */
  k: string;
  /** Formatted value including units — the backend decides the precision. */
  v: string;
  tier?: Tier;
  /** Set when the value is worse than some threshold and should read as a warning. */
  warn?: boolean;
}

export interface ResultCitation {
  doc_id: string;
  title: string;
  year?: number | null;
  url?: string;
  snippet?: string;
}

export interface AgentResult {
  result_id: string;
  query_id?: string;
  /** The question this answers, echoed so the panel can show it. */
  query?: string;
  kind: ResultKind;
  /** One line. The first thing a reviewer reads. */
  headline: string;
  /** A short paragraph. Keep it under about 60 words. */
  summary?: string;
  /** 0-1. Drives nothing automatic; it is shown, not acted on. */
  confidence?: number;
  /** True when a model wrote `headline`/`summary`. Labelled in the UI. */
  agent_generated?: boolean;
  metrics?: Metric[];
  citations?: ResultCitation[];
  view?: ResultView | null;
  /** Set when the lab wants a human decision before going further. */
  needs_review?: boolean;
}

// ---------------------------------------------------------------- examples

/**
 * One fixture per rendering path, so every branch can be exercised with the
 * arrows before the backend emits anything. Residue numbers are real positions
 * in 5XJH chain A — verified against the PDB — so the 3D view always has
 * something to point at.
 *
 * Between them these cover: a modelled side chain, a repainted stretch of
 * ribbon, an explicit `style` override, links of two different roles, and a
 * result that must leave the structure untouched.
 */
/**
 * What to draw when the backend does not say. Derived from `kind`, so a result
 * that omits `representation` still gets something sensible.
 */
export function defaultRepresentation(kind: ResultKind): Representation {
  switch (kind) {
    case "region":
      // A stretch of chain: the ribbon carries it, and SS colouring makes the
      // element the region sits in legible.
      return { base: "cartoon", color: "secondary_structure", termini: true };
    case "ranking":
      // Several positions at once; a quiet base keeps them distinguishable.
      return { base: "cartoon", color: "uniform" };
    case "none":
      return { base: "cartoon", color: "gradient" };
    default:
      return { base: "cartoon", color: "gradient", disulfides: false };
  }
}

export const RESULT_EXAMPLES: AgentResult[] = [
  {
    result_id: "ex-1-single",
    query: "what single substitution most improves thermostability",
    kind: "mutations",
    headline: "S121E is the strongest single substitution",
    summary:
      "Surface position on a flexible loop, 9.3 Å from the catalytic serine. Adding a carboxylate is predicted to form a salt bridge and rigidify the loop without touching the active site.",
    confidence: 0.78,
    agent_generated: true,
    metrics: [
      { k: "ESM-2 LLR", v: "+1.84", tier: "lookup" },
      { k: "ΔTm", v: "+8.8 °C", tier: "measured" },
      { k: "distance to active site", v: "9.3 Å", tier: "measured" },
    ],
    citations: [
      {
        doc_id: "europepmc:29374183",
        title: "Structural insight into molecular mechanism of PET degradation",
        year: 2018,
        snippet: "The narrow active site cleft accommodates the aromatic substrate.",
      },
    ],
    view: {
      protein_id: "IsPETase",
      chain: "A",
      focus: 121,
      mutations: [{ wt: "S", pos: 121, mut: "E", score: 1.84, tier: "lookup" }],
      highlights: [
        { residues: [121], role: "mutation", label: "S121E", detail: "proposed substitution" },
        { residues: [160, 206, 237], role: "active_site", label: "triad" },
      ],
      links: [{ from: 121, to: 160, label: "9.3 Å", role: "neutral" }],
    },
  },

  {
    result_id: "ex-2-combination",
    query: "which combination of three mutations works best together",
    kind: "mutations",
    headline: "S121E + D186H + R280A, with one risky pair",
    summary:
      "The additive estimate is favourable, but 121 and 186 sit 5.5 Å apart, so they are likely to interact and the sum should not be trusted on its own.",
    confidence: 0.62,
    agent_generated: true,
    metrics: [
      { k: "additive estimate", v: "+3.47", tier: "estimate" },
      { k: "measured", v: "+2.10", tier: "measured", warn: true },
      { k: "close pairs", v: "1", tier: "measured", warn: true },
    ],
    view: {
      protein_id: "IsPETase",
      chain: "A",
      focus: 186,
      mutations: [
        { wt: "S", pos: 121, mut: "E", score: 1.84, tier: "lookup" },
        { wt: "D", pos: 186, mut: "H", score: 1.21, tier: "lookup" },
        { wt: "R", pos: 280, mut: "A", score: 0.42, tier: "lookup" },
      ],
      highlights: [
        // The modelled side chains carry this one; repainting underneath them
        // would only compete with the thing being judged.
        { residues: [121, 186, 280], role: "mutation", label: "variant", style: "sticks" },
        { residues: [160, 206, 237], role: "active_site", label: "triad" },
      ],
      links: [{ from: 121, to: 186, label: "5.5 Å — likely to interact", role: "risk" }],
    },
  },

  {
    result_id: "ex-3-region",
    query: "which part of the protein should we be looking at",
    kind: "region",
    headline: "The 185–190 loop is the weak point",
    summary:
      "Highest local flexibility in the structure and second-shell to the catalytic serine. No single substitution stands out yet; this is where to search next.",
    confidence: 0.55,
    agent_generated: true,
    metrics: [{ k: "residues in region", v: "6", tier: "measured" }],
    view: {
      protein_id: "IsPETase",
      chain: "A",
      // A question about a stretch of chain: colour by element so the reviewer
      // can see whether the loop sits between a helix and a strand.
      representation: {
        base: "cartoon",
        color: "secondary_structure",
        disulfides: true,
        termini: true,
      },
      focus: 187,
      highlights: [
        {
          residues: [185, 186, 187, 188, 189, 190],
          role: "focus",
          label: "flexible loop",
          // Six residues of sticks would be noise; repaint the ribbon instead.
          style: "ribbon",
        },
        { residues: [160, 206, 237], role: "active_site", label: "triad" },
      ],
    },
  },

  {
    result_id: "ex-4-comparison",
    query: "is S121E better than D186H",
    kind: "comparison",
    headline: "S121E beats D186H on both counts",
    summary:
      "S121E scores higher and sits further from the active site. D186H is 5.4 Å from the catalytic serine, so it carries activity risk that the score does not capture.",
    confidence: 0.71,
    agent_generated: true,
    metrics: [
      { k: "S121E", v: "+1.84 · 9.3 Å", tier: "lookup" },
      { k: "D186H", v: "+1.21 · 5.4 Å", tier: "lookup", warn: true },
    ],
    view: {
      protein_id: "IsPETase",
      chain: "A",
      // Two candidates set against each other: mute the base so the only
      // colours on screen are the two being compared.
      representation: { base: "cartoon", color: "uniform" },
      focus: 160,
      highlights: [
        { residues: [121], role: "support", label: "S121E" },
        { residues: [186], role: "risk", label: "D186H — near active site" },
        { residues: [160, 206, 237], role: "active_site", label: "triad" },
      ],
      links: [
        { from: 121, to: 160, label: "9.3 Å", role: "support" },
        { from: 186, to: 160, label: "5.4 Å", role: "risk" },
      ],
    },
  },

  {
    result_id: "ex-5-ranking",
    query: "rank the candidates you have so far",
    kind: "ranking",
    headline: "Four candidates ranked, two worth testing",
    summary:
      "Ranked by predicted effect, filtered to positions more than 8 Å from the triad. The last two are inside the active site and were excluded rather than scored.",
    confidence: 0.66,
    agent_generated: true,
    metrics: [
      { k: "1. S121E", v: "+1.84", tier: "lookup" },
      { k: "2. N233K", v: "+1.44", tier: "lookup" },
      { k: "3. S238F", v: "+0.91", tier: "lookup" },
      { k: "4. D186H", v: "excluded — 5.4 Å", tier: "measured", warn: true },
    ],
    view: {
      protein_id: "IsPETase",
      chain: "A",
      focus: 121,
      highlights: [
        { residues: [121, 233, 238], role: "mutation", label: "shortlist", style: "ribbon" },
        { residues: [186], role: "risk", label: "excluded" },
        { residues: [160, 206, 237], role: "active_site", label: "triad" },
      ],
    },
  },

  {
    result_id: "ex-6-none",
    query: "what is the ticket price for the moon",
    kind: "none",
    headline: "No evidence in the corpus",
    summary:
      "Retrieval returned nothing above the similarity threshold, so there is no answer to give. Nothing was proposed and the structure is unchanged.",
    confidence: 0,
    agent_generated: false,
    metrics: [{ k: "sources above threshold", v: "0", tier: "measured", warn: true }],
    citations: [],
    view: null,
  },
];
