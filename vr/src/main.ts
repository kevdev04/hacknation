/**
 * PETase Lab — VR approval gate and combination bench.
 *
 * Two directions of the same loop. The gate pauses the agents on a flagged
 * candidate and sends a human decision back. The bench lets the reviewer stack
 * mutations into a variant, see the structural consequences immediately, and
 * propose it back as a human-origin candidate.
 *
 * Layout: the protein in the middle, the agent's candidate on the left, the
 * bench on the right, and the picked residue on a tilted surface below with a
 * leader line back to the atom it describes.
 *
 * Runs in the Quest browser via WebXR (`immersive-ar` so the protein sits in
 * the room, falling back to `immersive-vr`) and on the desktop with mouse
 * controls for iteration.
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Clock,
  Color,
  DirectionalLight,
  Euler,
  GridHelper,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  explore,
  getBridgeHealth,
  getBridgeRuns,
  getConfig,
  getQueue,
  getStructure,
  postDecision,
  proposeVariant,
  reviewer,
  scoreVariant,
  type Candidate,
  type DecisionKind,
  type BridgeHealth,
  type BridgeRun,
  type GateConfig,
  type VariantPayload,
} from "./api";
import { buildBackbone, oneLetter, parsePDB, type Structure } from "./protein";
import {
  buildBenchOverlay,
  buildHighlights,
  PickMarker,
  residueCentroid,
  type HighlightResult,
} from "./highlight";
import { ReviewPanel, type PanelState } from "./panel";
import { BenchPanel } from "./benchPanel";
import { ControlBar } from "./controlBar";
import { LogPanel, type Link, type LogEntry } from "./logPanel";
import { ResidueCard, type SubstitutionRow } from "./residueCard";
import { Bench } from "./bench";
import { epistasisPairs, residueMetrics, type EpistasisPair } from "./metrics";
import { loadScan, type Scan } from "./scan";
import { mutateResidue } from "./rotamer";
import { VoiceInput, voiceHealth } from "./voice";
import { XRInput } from "./input";
import { THEME, disposeGroup, makeGrabBar, type CanvasPanel } from "./ui";

const PROTEIN_ANCHOR = new Vector3(0, 1.38, -0.8);
const REVIEW_ANCHOR = new Vector3(-0.62, 1.44, -0.56);
const BENCH_ANCHOR = new Vector3(0.62, 1.44, -0.56);
const CARD_ANCHOR = new Vector3(0, 0.95, -0.52);
const TARGET_RADIUS_M = 0.3;
/** Desktop-only backdrop; passthrough replaces it with the real room. */
const DESKTOP_BG = 0xcfdae5;
const POLL_MS = 2000;

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const queueEl = document.getElementById("queue-line") as HTMLParagraphElement;
const xrButton = document.getElementById("enter-xr") as HTMLButtonElement;

function setStatus(text: string, state: "ok" | "error" = "ok"): void {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

// ---------------------------------------------------------------- renderer

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
// Quest 3S has headroom to spare at 1.0 but not much; foveation keeps the
// periphery cheap without touching the protein in the centre of view.
renderer.xr.setFoveation(0.5);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.5, 0.95);

scene.add(new HemisphereLight(0xffffff, 0xaebecd, 1.0));
scene.add(new AmbientLight(0xffffff, 0.35));
const sun = new DirectionalLight(0xffffff, 1.1);
sun.position.set(1.5, 3, 1.5);
scene.add(sun);

// Desktop-only scenery; hidden the moment an XR session starts so passthrough
// stays clean.
const scenery = new Group();
scenery.add(new GridHelper(6, 24, 0x93a9bd, 0xb6c6d5));
scene.add(scenery);
/**
 * `?passthrough=1` drops the backdrop so the page behind the canvas shows
 * through. Panel legibility only has to hold over an arbitrary room, and a
 * clean desktop grid flatters it in a way passthrough never will — this makes
 * that testable without putting the headset on.
 */
const SIMULATE_PASSTHROUGH =
  new URLSearchParams(location.search).get("passthrough") === "1";
scene.background = SIMULATE_PASSTHROUGH ? null : new Color(DESKTOP_BG);
if (SIMULATE_PASSTHROUGH) scenery.visible = false;

const proteinGroup = new Group();
proteinGroup.position.copy(PROTEIN_ANCHOR);
scene.add(proteinGroup);

const reviewPanel = new ReviewPanel();
reviewPanel.group.position.copy(REVIEW_ANCHOR);
reviewPanel.group.rotation.y = 0.55;
scene.add(reviewPanel.group);

const benchPanel = new BenchPanel();
benchPanel.group.position.copy(BENCH_ANCHOR);
benchPanel.group.rotation.y = -0.55;
scene.add(benchPanel.group);

const residueCard = new ResidueCard();
residueCard.group.position.copy(CARD_ANCHOR);
residueCard.group.rotation.x = -0.55;
scene.add(residueCard.group);

const controlBar = new ControlBar();
scene.add(controlBar.group);

const logPanel = new LogPanel();
scene.add(logPanel.group);

reviewPanel.addGrabBar();
benchPanel.addGrabBar();
residueCard.addGrabBar();
controlBar.addGrabBar();
logPanel.addGrabBar();

const pickMarker = new PickMarker();
proteinGroup.add(pickMarker.group);

/** The molecule's own handle, rebuilt per structure because it is sized in Å. */
let proteinHandle: Group | null = null;

// Leader line from the picked residue to the card describing it — the one
// piece of geometry that has to move every frame, so it mutates a preallocated
// attribute rather than rebuilding anything.
const leaderGeometry = new BufferGeometry();
leaderGeometry.setAttribute("position", new BufferAttribute(new Float32Array(6), 3));
const leaderLine = new Line(
  leaderGeometry,
  new LineBasicMaterial({ color: THEME.pick, transparent: true, opacity: 0.7 }),
);
leaderLine.visible = false;
leaderLine.frustumCulled = false;
scene.add(leaderLine);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(PROTEIN_ANCHOR);
controls.enableDamping = true;
controls.update();

// ------------------------------------------------------------- placement

/**
 * Where each surface sits *relative to the wearer's head*, not in fixed world
 * coordinates.
 *
 * Fixed anchors assume you are standing at the origin facing −Z, which is a
 * desktop assumption. In an `immersive-ar` session the `local-floor` origin is
 * wherever the system put it, so the whole workspace can end up beside or
 * behind you with no way to reach it. Laying out from the live head pose means
 * entering MR — or clicking the thumbstick — always puts the workspace in
 * front of you.
 *
 * Distances are chosen so nothing crowds the view: at ~1.4 m a 0.64 m panel
 * subtends about 26°, against roughly 60° when it sat at 0.56 m.
 */
interface LayoutSlot {
  object: Object3D;
  /** Metres right of the head (negative is left). */
  right: number;
  /** Metres above head height. */
  up: number;
  /** Metres in front of the head. */
  forward: number;
  /** Extra yaw on top of the head yaw, so side panels face inward. */
  yaw: number;
  /** Tilt, for the surface the reviewer looks down at. */
  pitch: number;
}

const layout: LayoutSlot[] = [
  { object: proteinGroup, right: 0, up: 0.02, forward: 1.15, yaw: 0, pitch: 0 },
  { object: reviewPanel.group, right: -0.78, up: 0.12, forward: 1.15, yaw: 0.6, pitch: 0 },
  { object: benchPanel.group, right: 0.78, up: 0.12, forward: 1.15, yaw: -0.6, pitch: 0 },
  { object: residueCard.group, right: 0, up: -0.5, forward: 0.85, yaw: 0, pitch: -0.62 },
  // Raised until its grab handle clears the molecule labels: the handle hangs
  // below the bar, so the bar body being clear was not enough.
  { object: controlBar.group, right: 0, up: 0.64, forward: 1.32, yaw: 0, pitch: 0.3 },
  // Under the gate panel on the left, clear of the residue card in the centre.
  { object: logPanel.group, right: -0.70, up: -0.38, forward: 1.04, yaw: 0.55, pitch: -0.22 },
];

const placeables: Object3D[] = layout.map((slot) => slot.object);

/** Walk up from a ray hit to the placeable that owns it. */
function placeableFor(object: Object3D): Object3D | null {
  let node: Object3D | null = object;
  while (node) {
    if (placeables.includes(node)) return node;
    node = node.parent;
  }
  return null;
}

const headPosition = new Vector3();
const headForward = new Vector3();
const slotOffset = new Vector3();
const headYawQuat = new Quaternion();
const slotQuat = new Quaternion();
const slotEuler = new Euler();

/**
 * Rebuild the whole workspace around wherever the user is now looking. In XR
 * the pose comes from the headset camera; on the desktop it comes from the
 * orbit camera, which keeps the two paths identical.
 */
function recenterLayout(): void {
  const head = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  head.getWorldPosition(headPosition);
  head.getWorldDirection(headForward);

  // Yaw only — never pitch or roll the workspace with the head, or looking
  // down would tip the panels over.
  const yaw = Math.atan2(-headForward.x, -headForward.z);
  headYawQuat.setFromEuler(slotEuler.set(0, yaw, 0, "YXZ"));

  for (const slot of layout) {
    const object = slot.object;
    if (object.parent !== scene) scene.add(object);

    slotOffset.set(slot.right, slot.up, -slot.forward).applyQuaternion(headYawQuat);
    object.position.copy(headPosition).add(slotOffset);
    object.quaternion.copy(headYawQuat).multiply(
      slotQuat.setFromEuler(slotEuler.set(slot.pitch, slot.yaw, 0, "YXZ")),
    );
    if (object !== proteinGroup) object.scale.setScalar(1);
  }

  // The orbit pivot has to follow the structure or desktop rotation goes wild.
  if (!renderer.xr.isPresenting) controls.target.copy(proteinGroup.position);
}

function resetLayout(): void {
  // Drop anything in hand first, or a surface would be rebuilt under a
  // controller that still thinks it owns it.
  input.releaseAll();
  recenterLayout();
  setStatus("layout reset in front of you");
}

function applyScale(target: Object3D, factor: number): void {
  if (target === proteinGroup) {
    const radius = currentStructure?.radius ?? 20;
    const min = (TARGET_RADIUS_M * 0.3) / radius;
    const max = (TARGET_RADIUS_M * 4) / radius;
    target.scale.setScalar(Math.min(Math.max(target.scale.x * factor, min), max));
    return;
  }
  target.scale.setScalar(Math.min(Math.max(target.scale.x * factor, 0.45), 2.2));
}

// ---------------------------------------------------------------- state

interface LoadedStructure {
  structure: Structure;
  backbone: Group;
}

const structureCache = new Map<string, LoadedStructure>();

let config: GateConfig | null = null;
let scan: Scan | null = null;

let queue: Candidate[] = [];
let index = 0;
let current: Candidate | null = null;
let currentStructure: Structure | null = null;
let highlights: HighlightResult | null = null;
let siteOverlay: Group | null = null;
let benchOverlay: Group | null = null;
let flash: PanelState["flash"] = null;
let flashUntil = 0;
let pickedPos: number | null = null;
let pickedCentroid: Vector3 | null = null;
let message: string | null = null;
let benchMessage: string | null = null;
let busy = false;
/** Counts down after an XR session starts; 0 means nothing pending. */
let pendingRecenterFrames = 0;
let bridgeHealth: BridgeHealth | null = null;
let gateReachable = false;

const bootedAt = performance.now();
const logEntries: LogEntry[] = [];

/** Append to the activity tail. Repeats are collapsed so one failing poll
 * every 2 s does not bury everything that came before it. */
function log(text: string, level: LogEntry["level"] = "info"): void {
  const last = logEntries[logEntries.length - 1];
  if (last && last.text === text) return;
  logEntries.push({ t: (performance.now() - bootedAt) / 1000, text, level });
  if (logEntries.length > 60) logEntries.shift();
}

function links(): Link[] {
  const scanReal = scan?.source === "model";
  return [
    {
      name: "Gate API",
      state: gateReachable ? "ok" : "down",
      detail: gateReachable
        ? `queue, decisions and structures · ${queue.length} pending`
        : "not answering — is the gate running on :8000?",
    },
    {
      name: "Agent lab bridge",
      state: bridgeHealth?.reachable ? "ok" : bridgeHealth ? "down" : "unknown",
      detail: bridgeHealth?.reachable
        ? `${bridgeHealth.bridge_url} · schema ${bridgeHealth.schema_version ?? "?"}`
        : `${bridgeHealth?.bridge_url ?? "unknown"} — start it or set BRIDGE_URL`,
    },
    {
      name: "Structure",
      state: currentStructure ? "ok" : "down",
      detail: currentStructure
        ? `${config?.structure_id ?? "?"} chain ${config?.chain ?? "?"} · ${currentStructure.residues.size} residues`
        : "no PDB loaded",
    },
    {
      name: "Voice",
      state: voiceAvailable ? "ok" : "degraded",
      detail: voiceAvailable
        ? "gate can transcribe · hold the bar button to ask"
        : "no OPENAI_API_KEY on the gate — voice disabled",
    },
    {
      name: "Mutation scores",
      state: scanReal ? "ok" : "degraded",
      detail: scanReal
        ? `${scan?.model} single-mutant scan`
        : "placeholder — GET /scan is not live yet",
    },
  ];
}

function fullyConnected(): boolean {
  return links().every((l) => l.state === "ok");
}
/** Newest unfinished exploration from the agent lab, if any. */
let activeRun: BridgeRun | null = null;
let voiceAvailable = false;

/** Push-to-talk. Repaints on every state change so the bar tracks it live. */
const voice = new VoiceInput(() => repaint());

async function beginVoice(): Promise<void> {
  if (!voiceAvailable || !voice.supported) return;
  await voice.start();
  if (voice.state === "recording") log("listening…");
}

async function endVoice(): Promise<void> {
  if (voice.state !== "recording") return;
  const result = await voice.stopAndSend();
  if (result?.ok) log(`heard: "${result.text}"`.slice(0, 70));
  else if (voice.lastError) log(`voice: ${voice.lastError}`, "warn");
}

/**
 * Hand the transcript to the agent lab. Separate from recording so a misheard
 * question can be discarded instead of silently becoming the next query.
 */
async function sendTranscript(): Promise<void> {
  const query = voice.lastText.trim();
  if (!query || voice.dispatching) return;
  voice.dispatching = true;
  repaint();
  try {
    const { query_id } = await explore(query, "mock");
    log(`sent to lab: "${query}" → ${query_id}`.slice(0, 70));
    voice.lastText = "";
    voice.lastError = null;
  } catch (error) {
    voice.lastError = `could not reach the lab: ${(error as Error).message}`;
    log(`send failed: ${(error as Error).message}`, "error");
  } finally {
    voice.dispatching = false;
    repaint();
  }
}

const bench = new Bench();

function activeSiteResidues(): number[] {
  return current?.active_site_residues ?? config?.active_site_residues ?? [];
}

function currentEpistasis(): EpistasisPair[] {
  if (!currentStructure) return [];
  return epistasisPairs(currentStructure, bench.enabledPositions);
}

// ---------------------------------------------------------------- painting

function panelState(): PanelState {
  return {
    candidate: current,
    queue,
    queueIndex: index,
    queueTotal: queue.length,
    measuredDistance: highlights?.distance ?? null,
    measuredNearest: highlights?.nearestResidue ?? null,
    wtMismatch: highlights?.wtMismatch ?? false,
    pickedResidue:
      pickedPos != null && currentStructure
        ? `${currentStructure.residues.get(pickedPos)?.resName ?? "?"} ${pickedPos}`
        : null,
    inBench:
      current && current.kind !== "claim" ? bench.has(current.mutation.pos) : false,
    flash,
    message,
    reviewer,
  };
}

function paintResidueCard(): void {
  if (pickedPos == null || !currentStructure) {
    residueCard.visible = false;
    leaderLine.visible = false;
    return;
  }

  const res = currentStructure.residues.get(pickedPos);
  if (!res) {
    residueCard.visible = false;
    leaderLine.visible = false;
    return;
  }

  const wt = oneLetter(res.resName);
  const substitutions: SubstitutionRow[] =
    scan?.ranked(pickedPos, wt).map((row) => ({
      mut: row.mut,
      llr: row.llr,
      inBench: bench.at(pickedPos!)?.mut === row.mut,
    })) ?? [];

  residueCard.render({
    pos: pickedPos,
    wt,
    resName: res.resName,
    chain: res.chain,
    metrics: residueMetrics(currentStructure, pickedPos, activeSiteResidues()),
    substitutions,
    scan,
    blocked: bench.full && !bench.has(pickedPos),
    isActiveSite: activeSiteResidues().includes(pickedPos),
  });

  residueCard.visible = true;
  leaderLine.visible = true;
}

function repaint(): void {
  reviewPanel.render(panelState());
  benchPanel.render({
    bench,
    epistasis: currentEpistasis(),
    scan,
    message: benchMessage,
    busy,
  });
  paintResidueCard();

  controlBar.render({
    headline: activeRun
      ? `${activeRun.stage} · ${activeRun.message || activeRun.query}`.slice(0, 64)
      : current
        ? `reviewing ${current.kind === "claim" ? (current.claim?.headline ?? "claim") : current.mutation.label}`.slice(0, 64)
        : "waiting for agents — bench is live",
    queueTotal: queue.length,
    benchCount: bench.count,
    reviewer,
    progress: activeRun ? activeRun.progress : null,
    voice: {
      state: voice.state,
      available: voiceAvailable && voice.supported,
      lastText: voice.lastText,
      lastError: voice.lastError,
      sending: voice.dispatching,
    },
  });

  logPanel.render({
    links: links(),
    entries: logEntries,
    fullyConnected: fullyConnected(),
  });

  queueEl.textContent = current
    ? `${current.candidate_id} · ${current.mutation.label} · ${index + 1}/${queue.length} pending · bench ${bench.count}`
    : `${queue.length} pending · bench ${bench.count}`;
}

// ---------------------------------------------------------------- structure

async function loadStructure(url: string, chain: string): Promise<LoadedStructure> {
  const key = `${url}#${chain}`;
  const hit = structureCache.get(key);
  if (hit) return hit;

  const text = await getStructure(url);
  const structure = parsePDB(text, chain);
  if (structure.residues.size === 0) {
    throw new Error(`no residues for chain ${chain} in ${url}`);
  }
  const loaded = { structure, backbone: buildBackbone(structure) };
  structureCache.set(key, loaded);
  return loaded;
}

async function mountStructure(url: string, chain: string): Promise<Structure> {
  const { structure, backbone } = await loadStructure(url, chain);
  if (currentStructure === structure) return structure;

  for (const child of [...proteinGroup.children]) {
    if (child.name === "backbone") proteinGroup.remove(child);
  }
  proteinGroup.add(backbone);
  proteinGroup.scale.setScalar(TARGET_RADIUS_M / structure.radius);
  currentStructure = structure;

  if (proteinHandle) {
    proteinGroup.remove(proteinHandle);
    disposeGroup(proteinHandle);
  }
  const handle = makeGrabBar(structure.radius * 0.75);
  handle.position.set(0, -structure.radius * 1.12, 0);
  proteinGroup.add(handle);
  proteinHandle = handle;

  if (new URLSearchParams(location.search).get("rotamertest") === "1") {
    void import("./rotamerTest").then((m) => m.runRotamerTest(structure));
  }

  // The catalytic triad is drawn even with no candidate queued, so the bench is
  // usable — and the active site is visible — while the agents are still
  // thinking.
  if (siteOverlay) {
    proteinGroup.remove(siteOverlay);
    disposeGroup(siteOverlay);
  }
  siteOverlay = buildHighlights(structure, {
    mutationPos: -1,
    mutationLabel: "",
    expectedWt: "",
    activeSite: activeSiteResidues(),
  }).group;
  proteinGroup.add(siteOverlay);

  return structure;
}

function rebuildBenchOverlay(): void {
  if (benchOverlay) {
    proteinGroup.remove(benchOverlay);
    disposeGroup(benchOverlay);
    benchOverlay = null;
  }
  if (!currentStructure || bench.count === 0) return;

  // Model the mutant side chain on the measured backbone. This is what makes
  // S121E look like a glutamate instead of a highlighted serine, and the clash
  // count it returns is a real structural signal the panel can show.
  benchOverlay = buildBenchOverlay(currentStructure, {
    mutations: bench.mutations.map((m) => {
      const built = mutateResidue(currentStructure!, m.pos, m.mut);
      m.clashes = built?.clashes;
      return {
        pos: m.pos,
        label: m.label,
        enabled: m.enabled,
        residue: built && !built.failed ? built.residue : null,
      };
    }),
    epistasis: currentEpistasis(),
  });
  proteinGroup.add(benchOverlay);
}

async function showCandidate(candidate: Candidate | null): Promise<void> {
  current = candidate;

  if (highlights) {
    proteinGroup.remove(highlights.group);
    disposeGroup(highlights.group);
    highlights = null;
  }

  if (siteOverlay) siteOverlay.visible = !candidate;

  if (!candidate) {
    repaint();
    return;
  }

  const structure = await mountStructure(candidate.pdb_url, candidate.chain);

  highlights = buildHighlights(structure, {
    mutationPos: candidate.mutation.pos,
    mutationLabel: candidate.mutation.label,
    expectedWt: candidate.mutation.wt,
    activeSite: candidate.active_site_residues,
  });
  proteinGroup.add(highlights.group);

  setStatus(`reviewing ${candidate.mutation.label} (${candidate.candidate_id})`);
  repaint();
}

// ---------------------------------------------------------------- gate flow

let healthChecks = 0;
/** Runs already written to the activity tail, so a finished one is not
 * re-reported on every poll. */
const reportedRuns = new Set<string>();

async function pollBridge(): Promise<void> {
  // Health changes rarely; the run list changes every tick.
  if (healthChecks++ % 10 === 0) {
    try {
      const next = await getBridgeHealth();
      if (bridgeHealth?.reachable !== next.reachable) {
        log(
          next.reachable
            ? `agent lab connected · ${next.bridge_url}`
            : `agent lab unreachable · ${next.bridge_url}`,
          next.reachable ? "info" : "warn",
        );
      }
      bridgeHealth = next;
    } catch {
      bridgeHealth = { bridge_url: "unknown", reachable: false };
    }
  }

  try {
    const { runs } = await getBridgeRuns();
    const previous = activeRun?.query_id;
    activeRun = runs.find((r) => !r.finished) ?? null;
    if (activeRun && activeRun.query_id !== previous) {
      log(`lab exploring: ${activeRun.query}`.slice(0, 70));
    }
    for (const run of runs) {
      if (!run.finished || reportedRuns.has(run.query_id)) continue;
      reportedRuns.add(run.query_id);
      if (run.error) log(`run ${run.query_id}: ${run.error}`, "error");
      else if (run.validation) {
        log(
          `run ${run.query_id} ${run.validation.verdict} in ${run.latency_ms} ms`,
          run.validation.verdict === "PASS" ? "info" : "warn",
        );
      }
    }
  } catch {
    // The bridge is optional: the gate works with the mock queue alone.
    activeRun = null;
  }
}

async function poll(): Promise<void> {
  try {
    await pollBridge();
    const { candidates } = await getQueue();
    message = null;
    if (!gateReachable) log("gate api connected");
    gateReachable = true;
    const previousId = current?.candidate_id;
    const known = new Set(queue.map((c) => c.candidate_id));
    for (const c of candidates) {
      if (!known.has(c.candidate_id)) {
        log(`queued ${c.kind} ${c.candidate_id} (${c.source})`);
      }
    }
    queue = candidates;

    if (queue.length === 0) {
      index = 0;
      if (current) await showCandidate(null);
      else repaint();
      setStatus("waiting for agents… bench is live");
      return;
    }

    const stillQueued = queue.findIndex((c) => c.candidate_id === previousId);
    if (stillQueued >= 0) {
      index = stillQueued;
      repaint();
      return;
    }
    index = Math.min(index, queue.length - 1);
    await showCandidate(queue[index]);
  } catch (error) {
    message = "gate api unreachable";
    gateReachable = false;
    log(`gate api unreachable: ${(error as Error).message}`, "error");
    setStatus(`gate api unreachable — ${(error as Error).message}`, "error");
    repaint();
  }
}

async function decide(decision: DecisionKind): Promise<void> {
  if (!current || busy) return;
  busy = true;
  const target = current;
  try {
    await postDecision(target.candidate_id, decision);
    log(`${decision} ${target.candidate_id}${target.approval_id ? " → relayed to lab" : ""}`);
    flash = { decision, label: `${target.mutation.label} · ${target.candidate_id}` };
    flashUntil = performance.now() + 1100;
    repaint();

    queue = queue.filter((c) => c.candidate_id !== target.candidate_id);
    index = Math.min(index, Math.max(queue.length - 1, 0));
    setStatus(`${decision} sent for ${target.mutation.label}`);
    await showCandidate(queue[index] ?? null);
  } catch (error) {
    log(`decision failed: ${(error as Error).message}`, "error");
    message = "decision failed";
    setStatus(`decision failed — ${(error as Error).message}`, "error");
    repaint();
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- bench flow

function benchChanged(note: string | null = null): void {
  benchMessage = note;
  rebuildBenchOverlay();
  repaint();
}

function addSubstitution(pos: number, mut: string): void {
  if (!currentStructure || !scan) return;
  const res = currentStructure.residues.get(pos);
  if (!res) return;

  const wt = oneLetter(res.resName);
  const added = bench.add({
    pos,
    wt,
    mut,
    label: `${wt}${pos}${mut}`,
    llr: scan.llr(pos, mut),
  });
  benchChanged(added ? null : "bench is full — remove a chip first");
}

/** Take the agent's flagged mutation onto the bench and explore around it. */
function loadCandidateIntoBench(): void {
  // A claim carries no residue; there is nothing to stack.
  if (!current || current.kind === "claim" || !currentStructure || !scan) return;
  const { pos, mut, wt } = current.mutation;
  const structureWt = oneLetter(
    currentStructure.residues.get(pos)?.resName ?? "",
  );
  const added = bench.add({
    pos,
    // The structure is the authority; the agent's claimed wild type may be the
    // thing that is wrong, which is what wt_mismatch flags.
    wt: structureWt !== "?" ? structureWt : wt,
    mut,
    label: current.mutation.label,
    llr: scan.llr(pos, mut),
  });
  pickedPos = pos;
  pickedCentroid = residueCentroid(currentStructure.residues.get(pos)!);
  benchChanged(added ? null : "bench is full — remove a chip first");
}

function variantPayload(tier: "estimate" | "measured"): VariantPayload | null {
  if (!config) return null;
  return {
    protein_id: config.protein_id,
    chain: config.chain,
    mutations: bench.labels(),
    score: { tier, esm_llr: bench.additiveEstimate() },
    epistasis_risk: currentEpistasis().map((pair) => ({
      pair: [pair.a, pair.b] as [number, number],
      distance_A: Math.round(pair.distance * 10) / 10,
    })),
    origin: "human",
    proposed_by: reviewer,
  };
}

async function requestMeasuredScore(): Promise<void> {
  const payload = variantPayload("estimate");
  if (!payload || busy) return;
  const estimate = bench.additiveEstimate();

  busy = true;
  benchMessage = "scoring…";
  repaint();
  try {
    const result = await scoreVariant(payload);
    const llr = result.score?.esm_llr;
    if (result.score?.tier === "measured" && typeof llr === "number") {
      bench.measured = { esm_llr: llr, estimateWhenRequested: estimate };
      benchMessage = null;
    } else {
      // Anything that is not an explicitly measured score stays off the panel:
      // the estimate keeps standing rather than being quietly upgraded.
      benchMessage = "gate returned no measured score — estimate stands";
    }
  } catch {
    benchMessage = "POST /variants/score not live yet — estimate stands";
  } finally {
    busy = false;
    repaint();
  }
}

async function propose(): Promise<void> {
  const payload = variantPayload(bench.measured ? "measured" : "estimate");
  if (!payload || busy) return;
  if (bench.measured) payload.score.esm_llr = bench.measured.esm_llr;

  busy = true;
  benchMessage = "proposing…";
  repaint();
  try {
    const result = await proposeVariant(payload);
    benchMessage = `proposed ${payload.mutations.join(" + ")} → ${result.variant_id}`;
    log(`proposed variant ${result.variant_id}`);
    setStatus(`variant proposed to the agent loop (${result.variant_id})`);
  } catch {
    benchMessage = "POST /proposals not live yet — variant not sent";
    log("POST /proposals not live yet", "warn");
  } finally {
    busy = false;
    repaint();
  }
}

// ---------------------------------------------------------------- picking

function closeCard(): void {
  pickedPos = null;
  pickedCentroid = null;
  pickMarker.hide();
  residueCard.visible = false;
  leaderLine.visible = false;
  repaint();
}

function pickProtein(raycaster: Raycaster): void {
  if (!currentStructure) return;
  const hits = raycaster.intersectObject(proteinGroup, true);
  const hit = hits.find(
    (h) =>
      h.object.type !== "Sprite" &&
      !h.object.userData.grabHandle &&
      isRayVisible(h.object),
  );
  if (!hit) {
    closeCard();
    return;
  }

  // World hit → structure space, then nearest CA wins.
  const local = proteinGroup.worldToLocal(hit.point.clone());
  let best: { resSeq: number; d: number } | null = null;
  for (const res of currentStructure.residues.values()) {
    if (!res.ca) continue;
    const d = res.ca.distanceTo(local);
    if (!best || d < best.d) best = { resSeq: res.resSeq, d };
  }
  if (!best) return;

  const res = currentStructure.residues.get(best.resSeq)!;
  pickMarker.show(res);
  pickedPos = res.resSeq;
  pickedCentroid = residueCentroid(res);
  repaint();
}

function handleAction(id: string): void {
  const [kind, value] = id.split(":");
  switch (kind) {
    case "gate":
      if (value === "bench") loadCandidateIntoBench();
      else if (value === "recenter") resetLayout();
      else void decide(value as DecisionKind);
      return;
    case "queue": {
      const found = queue.findIndex((c) => c.candidate_id === value);
      if (found >= 0 && found !== index) {
        index = found;
        void showCandidate(queue[found]);
      }
      return;
    }
    case "chip":
      bench.toggle(Number(value));
      benchChanged();
      return;
    case "del":
      bench.remove(Number(value));
      benchChanged();
      return;
    case "sub":
      if (pickedPos != null) addSubstitution(pickedPos, value);
      return;
    case "card":
      closeCard();
      return;
    case "voice":
      if (value === "send") {
        void sendTranscript();
      } else if (voice.state === "recording") {
        // Click to start, click again to stop — a canvas button has no hold.
        void endVoice();
      } else {
        void beginVoice();
      }
      return;
    case "act":
      if (value === "clear") {
        bench.clear();
        benchChanged();
      } else if (value === "score") {
        void requestMeasuredScore();
      } else if (value === "propose") {
        void propose();
      }
      return;
  }
}

const panelGroups = [
  reviewPanel.group,
  benchPanel.group,
  residueCard.group,
  controlBar.group,
  logPanel.group,
];

/** Panels take the ray first; anything that misses them falls through to the
 * structure, which is what makes picking a residue the default gesture. */
function activate(raycaster: Raycaster): void {
  const hit = raycaster
    .intersectObjects(panelGroups, true)
    .find((h) => h.uv && isRayVisible(h.object));
  if (hit) {
    const panel = hit.object.userData.panel as CanvasPanel | undefined;
    const id = panel?.hitTest(hit.uv as Vector2);
    if (id) handleAction(id);
    return;
  }
  pickProtein(raycaster);
}

/**
 * Desktop drags start only from a grab bar. The mouse uses one button for both
 * pressing controls and moving surfaces, so without this a shaky click on a
 * substitution would fling the card across the room. In VR grip and trigger are
 * separate buttons, so `resolveGrab` there stays forgiving.
 */
function resolveDragHandle(raycaster: Raycaster): Object3D | null {
  const hit = raycaster
    .intersectObjects(placeables, true)
    .find((h) => h.object.userData.grabHandle && isRayVisible(h.object));
  return hit ? placeableFor(hit.object) : null;
}

const grabProbe = new Vector3();

/**
 * Three's raycaster happily reports hits on objects inside a group whose
 * `visible` is false — it only skips them at render time. Without this filter
 * the hidden residue card, which sits between the viewer and the lower half of
 * the molecule, silently swallows every grab aimed at the structure.
 */
function isRayVisible(object: Object3D): boolean {
  let node: Object3D | null = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

/**
 * Whatever the grip should pick up: the nearest visible surface the ray hits,
 * or — when the aim misses everything — the nearest surface within arm's reach.
 * Requiring a precise hit made the squeeze silently do nothing, which reads as
 * broken. Everything is tested together so the closest surface wins rather than
 * the panels always taking priority over the molecule.
 */
function resolveGrab(raycaster: Raycaster, gripPosition?: Vector3): Object3D | null {
  const hit = raycaster
    .intersectObjects(placeables, true)
    .find((h) => isRayVisible(h.object));
  if (hit) return placeableFor(hit.object);

  if (!gripPosition) return null;
  let nearest: Object3D | null = null;
  let nearestDistance = 1.6;
  for (const object of placeables) {
    if (!object.visible) continue;
    const distance = object.getWorldPosition(grabProbe).distanceTo(gripPosition);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = object;
    }
  }
  return nearest;
}

// ---------------------------------------------------------- desktop drag

const pickRay = new Raycaster();
const pointerNDC = new Vector2();
const dragPlane = new Plane();
const dragOffset = new Vector3();
const dragNormal = new Vector3();
const dragAnchor = new Vector3();
const dragHit = new Vector3();

interface PointerDrag {
  object: Object3D | null;
  startX: number;
  startY: number;
  ndc: Vector2;
  moved: boolean;
}

let pointerDrag: PointerDrag | null = null;

function setPointerRay(clientX: number, clientY: number): void {
  pointerNDC.set(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1,
  );
  pickRay.setFromCamera(pointerNDC, camera);
}

// Capture phase so OrbitControls does not start an orbit when the press lands
// on something placeable — its own listener runs after this one.
renderer.domElement.addEventListener(
  "pointerdown",
  (event) => {
    if (renderer.xr.isPresenting || event.button !== 0) return;
    setPointerRay(event.clientX, event.clientY);

    // Only a handle can be dragged, but a press anywhere on a surface still
    // suppresses the orbit — otherwise dragging across a panel spins the view.
    const object = resolveDragHandle(pickRay);
    const overSurface = object ?? resolveGrab(pickRay);
    pointerDrag = {
      object,
      startX: event.clientX,
      startY: event.clientY,
      ndc: pointerNDC.clone(),
      moved: false,
    };
    if (overSurface) controls.enabled = false;
    if (!object) return;

    // Drag in the plane facing the camera through the object's own position,
    // so it tracks the cursor without changing its distance from the viewer.
    camera.getWorldDirection(dragNormal);
    object.getWorldPosition(dragAnchor);
    dragPlane.setFromNormalAndCoplanarPoint(dragNormal, dragAnchor);
    if (pickRay.ray.intersectPlane(dragPlane, dragHit)) {
      dragOffset.copy(dragAnchor).sub(dragHit);
    } else {
      dragOffset.set(0, 0, 0);
    }
  },
  true,
);

window.addEventListener("pointermove", (event) => {
  if (!pointerDrag) return;

  if (!pointerDrag.moved) {
    const dx = event.clientX - pointerDrag.startX;
    const dy = event.clientY - pointerDrag.startY;
    // A press that never travels is a click, not a drag.
    if (dx * dx + dy * dy < 16) return;
    pointerDrag.moved = true;
  }

  const object = pointerDrag.object;
  if (!object) return;
  setPointerRay(event.clientX, event.clientY);
  if (pickRay.ray.intersectPlane(dragPlane, dragHit)) {
    object.position.copy(dragHit).add(dragOffset);
  }
});

window.addEventListener("pointerup", () => {
  if (!pointerDrag) return;
  if (!pointerDrag.moved) {
    pickRay.setFromCamera(pointerDrag.ndc, camera);
    activate(pickRay);
  }
  controls.enabled = true;
  pointerDrag = null;
});

window.addEventListener("keyup", (event) => {
  if (event.key === "v") void endVoice();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "1") void decide("approve");
  if (event.key === "2") void decide("reject");
  if (event.key === "3") void decide("defer");
  if (event.key === "b") loadCandidateIntoBench();
  if (event.key === "p") void propose();
  if (event.key === "r") resetLayout();
  if (event.key === "v" && !event.repeat) void beginVoice();
  if (event.key === "Escape") closeCard();
});

// ---------------------------------------------------------------- xr input

const input = new XRInput(renderer, scene, {
  onDecision: (decision) => void decide(decision),
  onPick: activate,
  resolveGrab,
  resolveHandle: resolveDragHandle,
  onReset: resetLayout,
  onVoiceStart: () => void beginVoice(),
  onVoiceEnd: () => void endVoice(),
  // Scaling applies to whatever that hand is holding; with an empty hand it
  // falls back to the structure, which is the old behaviour.
  onScale: (factor, held) => applyScale(held ?? proteinGroup, factor),
});

// ---------------------------------------------------------------- session

async function pickSessionMode(): Promise<"immersive-ar" | "immersive-vr" | null> {
  if (!navigator.xr) return null;
  if (await navigator.xr.isSessionSupported("immersive-ar")) return "immersive-ar";
  if (await navigator.xr.isSessionSupported("immersive-vr")) return "immersive-vr";
  return null;
}

async function enterXR(mode: "immersive-ar" | "immersive-vr"): Promise<void> {
  const session = await navigator.xr!.requestSession(mode, {
    optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking", "layers"],
  });
  await renderer.xr.setSession(session);
  renderer.xr.setReferenceSpaceType("local-floor");

  const passthrough = mode === "immersive-ar";
  scenery.visible = !passthrough;
  scene.background = passthrough ? null : new Color(DESKTOP_BG);
  xrButton.textContent = "exit XR";
  setStatus(`${mode} session active`);

  // The headset pose is not meaningful until the session has produced a few
  // frames, so the workspace is laid out from the render loop rather than here.
  pendingRecenterFrames = 4;

  session.addEventListener("end", () => {
    pendingRecenterFrames = 0;
    scenery.visible = true;
    /**
 * `?passthrough=1` drops the backdrop so the page behind the canvas shows
 * through. Panel legibility only has to hold over an arbitrary room, and a
 * clean desktop grid flatters it in a way passthrough never will — this makes
 * that testable without putting the headset on.
 */
const SIMULATE_PASSTHROUGH =
  new URLSearchParams(location.search).get("passthrough") === "1";
scene.background = SIMULATE_PASSTHROUGH ? null : new Color(DESKTOP_BG);
if (SIMULATE_PASSTHROUGH) scenery.visible = false;
    xrButton.textContent = mode === "immersive-ar" ? "enter mixed reality" : "enter VR";
    setStatus("XR session ended");
  });
}

void (async () => {
  const mode = await pickSessionMode();
  if (!mode) {
    xrButton.textContent = "no XR device";
    xrButton.disabled = true;
    return;
  }
  xrButton.disabled = false;
  xrButton.textContent = mode === "immersive-ar" ? "enter mixed reality" : "enter VR";
  xrButton.addEventListener("click", () => {
    const session = renderer.xr.getSession();
    if (session) void session.end();
    else enterXR(mode).catch((error) => setStatus(`XR failed — ${error.message}`, "error"));
  });
})();

// ---------------------------------------------------------------- loop

const clock = new Clock();
const leaderA = new Vector3();
const leaderB = new Vector3();


function updateLeaderLine(): void {
  if (!leaderLine.visible || !pickedCentroid) return;
  leaderA.copy(pickedCentroid).applyMatrix4(proteinGroup.matrixWorld);
  leaderB.set(0, residueCard.heightMeters / 2, 0.01);
  residueCard.group.localToWorld(leaderB);

  const positions = leaderGeometry.attributes.position as BufferAttribute;
  positions.setXYZ(0, leaderA.x, leaderA.y, leaderA.z);
  positions.setXYZ(1, leaderB.x, leaderB.y, leaderB.z);
  positions.needsUpdate = true;
}

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.1);

  input.update(renderer.xr.getSession(), delta);
  if (!renderer.xr.isPresenting) controls.update();

  if (pendingRecenterFrames > 0 && renderer.xr.isPresenting) {
    pendingRecenterFrames--;
    if (pendingRecenterFrames === 0) recenterLayout();
  }

  updateLeaderLine();

  if (flash && performance.now() > flashUntil) {
    flash = null;
    repaint();
  }

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- boot

void (async () => {
  setStatus("connecting to gate api…");
  repaint();

  recenterLayout();
  log("viewer started");

  try {
    const health = await voiceHealth();
    voiceAvailable = health.configured;
    log(
      voiceAvailable ? `voice ready · ${health.model}` : "voice off · no key on the gate",
      voiceAvailable ? "info" : "warn",
    );
  } catch {
    voiceAvailable = false;
  }

  try {
    config = await getConfig();
    await mountStructure(config.pdb_url, config.chain);
    scan = await loadScan(config.protein_id, config.chain);
    setStatus(
      scan.source === "model"
        ? `${config.protein_id} ${config.structure_id} · ${scan.model} scan loaded`
        : `${config.protein_id} ${config.structure_id} · placeholder scores (no /scan yet)`,
    );
    log(
      `${config.protein_id} ${config.structure_id} loaded · scores ${scan.source}`,
      scan.source === "model" ? "info" : "warn",
    );
  } catch (error) {
    gateReachable = false;
    log(`boot failed: ${(error as Error).message}`, "error");
    setStatus(`gate api unreachable — ${(error as Error).message}`, "error");
  }
  repaint();

  await poll();
})();

// Polling lives on a timer, not in the render loop: a backgrounded tab (or a
// headset that has gone to sleep) parks requestAnimationFrame, and the queue
// must keep tracking the agent loop regardless.
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void poll().finally(() => {
    polling = false;
  });
}, POLL_MS);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
