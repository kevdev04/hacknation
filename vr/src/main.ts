/**
 * PETase Lab — VR.
 *
 * One loop, three surfaces around the molecule:
 *
 *   left    the project — every question this session, the experiments worth
 *           keeping, and a log of what the system actually did
 *   below   the console — where a question is spoken and sent, carrying the
 *           format contract the lab must answer in
 *   right   the answer — brief by default, "Review in depth" for the rest
 *
 * The molecule in the middle is driven entirely by the answer's `view`: the
 * backend names residues and roles, the viewer decides how they look.
 *
 * Runs in the Quest browser via WebXR (`immersive-ar` so the protein sits in
 * the room, falling back to `immersive-vr`) and on the desktop with mouse
 * controls for iteration.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
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
  LineDashedMaterial,
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
  deleteExperiment,
  explore,
  getBridgeHealth,
  getBridgeRuns,
  getConfig,
  getExperiments,
  getQueue,
  getStructure,
  postDecision,
  saveExperiment,
  reviewer,
  type SavedExperimentRecord,
  type Candidate,
  type DecisionKind,
  type BridgeHealth,
  type BridgeRun,
  type FullHealth,
  type GateConfig,
} from "./api";
import {
  buildCartoon,
  buildResidueSticks,
  findDisulfides,
  recolorCartoon,
  schemeColors,
  termini,
  closestAtomPair,
  parsePDB,
  type Structure,
} from "./protein";
import {
  buildHighlights,
  makeLabel,
  PickMarker,
  residueCentroid,
} from "./highlight";
import {
  ProjectPanel,
  type LogLine,
  type ProjectLink,
  type ProjectTab,
  type QuestionStatus,
  type SessionQuestion,
} from "./projectPanel";
import { ConsolePanel } from "./console";
import { AnswerPanel } from "./answerPanel";
import {
  defaultRepresentation,
  RESULT_EXAMPLES,
  type AgentResult,
  type Representation,
} from "./result";
import { buildAgentPrompt, parseAnswer, promptSize } from "./prompt";
import { ControlBar } from "./controlBar";
import { mutateResidue } from "./rotamer";
import { VoiceInput, voiceHealth } from "./voice";
import { startHealthHud } from "./healthHud";
import { XRInput } from "./input";
import { disposeGroup, makeGrabBar, type CanvasPanel } from "./ui";

const PROTEIN_ANCHOR = new Vector3(0, 1.38, -0.8);
const TARGET_RADIUS_M = 0.3;
/** Desktop-only backdrop; passthrough replaces it with the real room. */
const DESKTOP_BG = 0xcfdae5;
const POLL_MS = 2000;
const SCROLL_STEP = 170;

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const queueEl = document.getElementById("queue-line") as HTMLParagraphElement;
const xrButton = document.getElementById("enter-xr") as HTMLButtonElement;

function setStatus(text: string, state: "ok" | "error" = "ok"): void {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

/**
 * `?passthrough=1` drops the backdrop so the page behind the canvas shows
 * through. Panel legibility only has to hold over an arbitrary room, and a
 * clean desktop grid flatters it in a way passthrough never will — this makes
 * that testable without putting the headset on.
 */
const SIMULATE_PASSTHROUGH =
  new URLSearchParams(location.search).get("passthrough") === "1";

// ---------------------------------------------------------------- renderer

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
// Quest 3S has headroom to spare at 1.0 but not much; foveation keeps the
// periphery cheap without touching the protein in the centre of view.
renderer.xr.setFoveation(0.5);
// ACES keeps the specular on a glossy ribbon from clipping to flat white,
// which is most of what made the old tube read as plastic.
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.5, 0.95);

// Three-point lighting. A single sun plus ambient flattens a ribbon into a
// silhouette; a key, a cool fill from the opposite side and a rim behind are
// what make the depth of the fold readable.
scene.add(new HemisphereLight(0xf4f9ff, 0x9fb3c6, 0.75));
scene.add(new AmbientLight(0xffffff, 0.22));

const key = new DirectionalLight(0xfff6ec, 1.25);
key.position.set(1.6, 2.6, 1.8);
scene.add(key);

const fill = new DirectionalLight(0xcfe2ff, 0.55);
fill.position.set(-2.0, 0.4, 1.0);
scene.add(fill);

const rim = new DirectionalLight(0xffffff, 0.7);
rim.position.set(-0.6, 1.2, -2.2);
scene.add(rim);

// Desktop-only scenery; hidden the moment an XR session starts so passthrough
// stays clean.
const scenery = new Group();
scenery.add(new GridHelper(6, 24, 0x93a9bd, 0xb6c6d5));
scene.add(scenery);

function setDesktopBackdrop(): void {
  scene.background = SIMULATE_PASSTHROUGH ? null : new Color(DESKTOP_BG);
  scenery.visible = !SIMULATE_PASSTHROUGH;
}
setDesktopBackdrop();

const proteinGroup = new Group();
proteinGroup.position.copy(PROTEIN_ANCHOR);
scene.add(proteinGroup);

const projectPanel = new ProjectPanel();
scene.add(projectPanel.group);

const answerPanel = new AnswerPanel();
scene.add(answerPanel.group);

const consolePanel = new ConsolePanel();
scene.add(consolePanel.group);

const controlBar = new ControlBar();
scene.add(controlBar.group);

projectPanel.addGrabBar();
answerPanel.addGrabBar();
consolePanel.addGrabBar();
controlBar.addGrabBar();

const pickMarker = new PickMarker();
proteinGroup.add(pickMarker.group);

/** The molecule's own handle, rebuilt per structure because it is sized in Å. */
let proteinHandle: Group | null = null;

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
  { object: proteinGroup, right: 0, up: 0.04, forward: 1.15, yaw: 0, pitch: 0 },
  { object: projectPanel.group, right: -0.80, up: 0.10, forward: 1.18, yaw: 0.6, pitch: 0 },
  { object: answerPanel.group, right: 0.80, up: 0.12, forward: 1.16, yaw: -0.6, pitch: 0 },
  // The console is where a session starts, so it sits where the hands are:
  // below the molecule, tilted up toward the face.
  { object: consolePanel.group, right: 0, up: -0.40, forward: 0.96, yaw: 0, pitch: -0.42 },
  // Raised until its grab handle clears the molecule labels: the handle hangs
  // below the bar, so the bar body being clear was not enough.
  { object: controlBar.group, right: 0, up: 0.64, forward: 1.32, yaw: 0, pitch: 0.3 },
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
let currentStructure: Structure | null = null;
let siteOverlay: Group | null = null;
let pickedPos: number | null = null;
/** Counts down after an XR session starts; 0 means nothing pending. */
let pendingRecenterFrames = 0;
let bridgeHealth: BridgeHealth | null = null;
let gateReachable = false;
let voiceAvailable = false;
/** Candidates the lab has flagged for a human. Logged, decided by keyboard. */
let queue: Candidate[] = [];

const bootedAt = performance.now();
const logEntries: LogLine[] = [];

/** Seconds since the viewer started — the clock every log line and question
 * is stamped with, so the session reads in order. */
function now(): number {
  return (performance.now() - bootedAt) / 1000;
}

/** Append to the run log. Repeats are collapsed so one failing poll every 2 s
 * does not bury everything that came before it. */
function log(text: string, level: LogLine["level"] = "info"): void {
  const last = logEntries[logEntries.length - 1];
  if (last && last.text === text) return;
  logEntries.push({ t: now(), text, level });
  if (logEntries.length > 80) logEntries.shift();
}

function links(): ProjectLink[] {
  return [
    {
      name: "Gate API",
      ok: gateReachable,
      detail: gateReachable
        ? `queries, experiments and structures · ${queue.length} flagged for review`
        : "not answering — is the gate running on :8000?",
    },
    {
      name: "Agent lab bridge",
      ok: !!bridgeHealth?.reachable,
      detail: bridgeHealth?.reachable
        ? `${bridgeHealth.bridge_url} · schema ${bridgeHealth.schema_version ?? "?"}`
        : `${bridgeHealth?.bridge_url ?? "unknown"} — start it or set BRIDGE_URL`,
    },
    {
      // The gate saying its own structure and audit trail are in one piece.
      // Distinct from "Structure" below, which is what this viewer has parsed.
      name: "Gate data",
      ok: !!fullHealth?.data.ok,
      detail: fullHealth?.data.ok
        ? `${fullHealth.data.structure} triad ${fullHealth.data.triad} · audit trail writable`
        : fullHealth
          ? "structure or state directory unavailable on the gate"
          : "not checked yet",
    },
    {
      name: "Structure",
      ok: !!currentStructure,
      detail: currentStructure
        ? `${config?.structure_id ?? "?"} chain ${config?.chain ?? "?"} · ${currentStructure.residues.size} residues`
        : "no PDB loaded",
    },
    {
      name: "Voice",
      ok: voiceAvailable,
      detail: voiceAvailable
        ? "gate can transcribe · hold the console button to ask"
        : "no OPENAI_API_KEY on the gate — voice disabled",
    },
  ];
}

/** Last /health/full, shared by the desktop HUD lights and the in-world links. */
let fullHealth: FullHealth | null = null;
startHealthHud((next) => {
  if (next && fullHealth && next.data.ok !== fullHealth.data.ok) {
    log(next.data.ok ? "gate data ok" : "gate data unavailable", next.data.ok ? "info" : "error");
  }
  fullHealth = next;
});

/** The residue under the ray, named for the console. */
function pickedLabel(): string | null {
  if (pickedPos == null || !currentStructure) return null;
  const res = currentStructure.residues.get(pickedPos);
  return res ? `${res.resName} ${res.resSeq}` : null;
}

function fullyConnected(): boolean {
  return links().every((l) => l.ok);
}

// ------------------------------------------------------------ the project

let projectTab: ProjectTab = "questions";
let projectScroll = 0;
const questions: SessionQuestion[] = [];
let experiments: SavedExperimentRecord[] = [];
/** Newest unfinished exploration from the agent lab, if any. */
let activeRun: BridgeRun | null = null;

/**
 * One answer the reviewer can look at.
 *
 * `prose` and `problem` are kept beside the result rather than in it: they are
 * facts about *this reply*, not part of the contract, and a saved experiment
 * should not carry a complaint about formatting into the record.
 */
interface AnswerEntry {
  result: AgentResult | null;
  prose: string;
  problem: string | null;
  /** True for the built-in examples, so they are never saved as findings. */
  example?: boolean;
}

// Seeded with the example set so every rendering path can be exercised with the
// arrows before the lab sends anything.
const answers: AnswerEntry[] = RESULT_EXAMPLES.map((result) => ({
  result,
  prose: "",
  problem: null,
  example: true,
}));
let answerIndex = 0;
let answerDeep = false;
let answerScroll = 0;

function currentAnswer(): AnswerEntry | null {
  return answers[answerIndex] ?? null;
}

/** Show an answer and rebuild the molecule from it. */
function selectAnswer(index: number): void {
  if (index < 0 || index >= answers.length) return;
  answerIndex = index;
  answerDeep = false;
  answerScroll = 0;
  applyResultView(currentAnswer()?.result ?? null);
}

function markQuestion(query_id: string, patch: Partial<SessionQuestion>): void {
  const q = questions.find((item) => item.query_id === query_id);
  if (!q) return;
  Object.assign(q, patch);
  for (const other of questions) other.current = other === q;
}

// ---------------------------------------------------------------- voice

/** Push-to-talk. Repaints on every state change so the console tracks it live. */
const voice = new VoiceInput(() => repaint());

async function beginVoice(): Promise<boolean> {
  if (!voiceAvailable || !voice.supported) return false;
  await voice.start();
  const started = voice.state === "recording";
  if (started) log("listening…");
  return started;
}

async function endVoice(): Promise<void> {
  if (voice.state !== "recording") return;
  const result = await voice.stopAndSend();
  if (!result?.ok) {
    if (voice.lastError) log(`voice: ${voice.lastError}`, "warn");
  } else {
    log(`heard: "${result.text}"`.slice(0, 70));
  }
  repaint();
}

/**
 * Hand the question to the agent lab, with the contract attached.
 *
 * The question never travels alone: `buildAgentPrompt` wraps it in the format
 * the answer must come back in, because a bare question gets prose back and
 * prose renders as nothing in the middle of the room.
 */
async function sendQuestion(): Promise<void> {
  const query = voice.lastText.trim();
  if (!query || voice.dispatching) return;

  voice.dispatching = true;
  repaint();
  try {
    const mode = bridgeHealth?.reachable ? "live" : "mock";
    const { query_id } = await explore(buildAgentPrompt(query), mode);

    for (const q of questions) q.current = false;
    questions.push({ query_id, query, status: "running", at: now(), current: true });
    if (questions.length > 40) questions.shift();

    log(`asked the lab (${mode}): "${query}" → ${query_id}`.slice(0, 76));
    voice.lastText = "";
    voice.lastError = null;
    projectTab = "questions";
    projectScroll = 0;
  } catch (error) {
    voice.lastError = `could not reach the lab: ${(error as Error).message}`;
    log(`send failed: ${(error as Error).message}`, "error");
  } finally {
    voice.dispatching = false;
    repaint();
  }
}

// ---------------------------------------------------------------- painting

function repaint(): void {
  const answer = currentAnswer();
  const busy = !!activeRun;

  projectPanel.render({
    tab: projectTab,
    scroll: projectScroll,
    reviewer,
    questions,
    experiments,
    log: logEntries,
    links: links(),
    connected: fullyConnected(),
  });

  answerPanel.render({
    result: answer?.result ?? null,
    prose: answer?.prose ?? "",
    problem: answer?.problem ?? null,
    deep: answerDeep,
    scroll: answerScroll,
    index: answerIndex,
    count: answers.length,
    busy,
    busyStage: activeRun ? `${activeRun.stage} · ${activeRun.message || activeRun.query}`.slice(0, 60) : null,
    busyProgress: activeRun ? activeRun.progress : null,
  });

  consolePanel.render({
    reviewer,
    voiceAvailable: voiceAvailable && voice.supported,
    voiceState: voice.state,
    transcript: voice.lastText,
    error: voice.lastError,
    sending: voice.dispatching,
    busyStage: activeRun ? activeRun.stage : null,
    asked: questions.length,
    picked: pickedLabel(),
    contextChars: promptSize(voice.lastText).context,
  });

  controlBar.render({
    headline: activeRun
      ? `${activeRun.stage} · ${activeRun.message || activeRun.query}`.slice(0, 64)
      : (answer?.result?.headline ?? "ask the console what to look at").slice(0, 64),
    reviewer,
    asked: questions.length,
    saved: experiments.length,
    progress: activeRun ? activeRun.progress : null,
    connected: fullyConnected(),
  });

  queueEl.textContent = `${questions.length} asked · ${experiments.length} saved · ${queue.length} flagged for review`;
}

// ---------------------------------------------------------------- structure

async function loadStructure(url: string, chain: string): Promise<LoadedStructure> {
  const cacheKey = `${url}#${chain}`;
  const hit = structureCache.get(cacheKey);
  if (hit) return hit;

  const text = await getStructure(url);
  const structure = parsePDB(text, chain);
  if (structure.residues.size === 0) {
    throw new Error(`no residues for chain ${chain} in ${url}`);
  }
  const loaded = { structure, backbone: buildCartoon(structure) };
  structureCache.set(cacheKey, loaded);
  return loaded;
}

function activeSiteResidues(): number[] {
  return config?.active_site_residues ?? [];
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

  // The catalytic triad is drawn with no question asked, so the active site is
  // visible while the lab is still thinking. Its numbering comes from the
  // backend config, which verified it against this PDB file.
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

/**
 * Draw an AgentResult's `view` on the structure.
 *
 * The backend speaks in residues and roles; the mapping from role to colour
 * lives here, so the contract stays stable while the visuals change. Mutations
 * in the view are modelled on the real backbone, so a proposed substitution is
 * shown as the residue it would become.
 */
let resultOverlay: Group | null = null;

const ROLE_COLOR: Record<string, number> = {
  mutation: 0x2461c4,
  active_site: 0x0d8277,
  focus: 0xd1820a,
  risk: 0xc2384b,
  support: 0x116a4f,
  neutral: 0x5f7488,
};

function applyResultView(result: AgentResult | null): void {
  if (resultOverlay) {
    proteinGroup.remove(resultOverlay);
    disposeGroup(resultOverlay);
    resultOverlay = null;
  }
  const backbone = proteinGroup.children.find((c) => c.name === "backbone") as
    | Group
    | undefined;

  const view = result?.view;
  if (!currentStructure || !view) {
    if (backbone) recolorCartoon(backbone, new Map());
    if (siteOverlay) siteOverlay.visible = true;
    repaint();
    return;
  }

  const group = new Group();
  group.name = "result-overlay";

  // The answer's own highlights speak for the active site when they name it;
  // keeping the standing triad overlay as well would double every label.
  if (siteOverlay) siteOverlay.visible = false;

  // Substitutions become real side chains, not just coloured spheres.
  const modelled = (view.mutations ?? [])
    .map((m) => mutateResidue(currentStructure!, m.pos, m.mut))
    .filter((r): r is NonNullable<typeof r> => !!r && !r.failed)
    .map((r) => r.residue);
  if (modelled.length) {
    group.add(
      buildResidueSticks(modelled, {
        color: ROLE_COLOR.mutation,
        sideChainOnly: true,
      }),
    );
  }

  // The base model first: the scheme paints every residue, then highlights
  // paint over the ones they name.
  const rep: Representation = view.representation ?? defaultRepresentation(result.kind);
  const repaintBase = schemeColors(currentStructure, rep.color);

  if (rep.disulfides) {
    for (const ss of findDisulfides(currentStructure)) {
      const line = new Line(
        new BufferGeometry().setFromPoints([ss.posA, ss.posB]),
        new LineBasicMaterial({ color: 0xe8c33a, linewidth: 2 }),
      );
      group.add(line);
      const mid = ss.posA.clone().add(ss.posB).multiplyScalar(0.5);
      const label = makeLabel(`SS ${ss.a}-${ss.b}`, 0xb08900, 1.5);
      label.position.copy(mid).add(new Vector3(0, 1.6, 0));
      group.add(label);
    }
  }

  if (rep.termini) {
    const ends = termini(currentStructure);
    if (ends) {
      for (const [res, text, color] of [
        [ends.n, "N", 0x2461c4],
        [ends.c, "C", 0xa62638],
      ] as const) {
        const label = makeLabel(text, color, 3.0);
        label.position.copy(residueCentroid(res)).add(new Vector3(0, 3.2, 0));
        group.add(label);
      }
    }
  }

  // Highlights repaint the ribbon itself. Drawing a second representation over
  // the cartoon was what made a result look like two models fighting rather
  // than one molecule responding.
  const repaintMap = new Map<number, Color>(repaintBase);
  const mutated = new Set((view.mutations ?? []).map((m) => m.pos));

  for (const h of view.highlights ?? []) {
    const color = new Color(ROLE_COLOR[h.role] ?? ROLE_COLOR.neutral);
    const residues = h.residues
      .map((pos) => currentStructure!.residues.get(pos))
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (residues.length === 0) continue;

    for (const res of residues) repaintMap.set(res.resSeq, color);

    // The catalytic triad and anything the reviewer must judge chemically keep
    // their side chains drawn; a whole highlighted loop does not need 6 of them.
    // A highlight may override that with `style`.
    const defaultSticks =
      h.role === "active_site" || h.role === "risk" || residues.length <= 2;
    const wantsSticks = h.style ? h.style !== "ribbon" : defaultSticks;
    if (h.style === "sticks") for (const res of residues) repaintMap.delete(res.resSeq);
    if (wantsSticks) {
      const drawable = residues.filter((r) => !mutated.has(r.resSeq));
      if (drawable.length) {
        group.add(
          buildResidueSticks(drawable, { color: color.getHex(), sideChainOnly: true }),
        );
      }
    }

    if (h.label) {
      const centre = residueCentroid(residues[Math.floor(residues.length / 2)]);
      const label = makeLabel(h.label, color.getHex(), 2.6);
      label.position.copy(centre).add(new Vector3(0, 4.6, 0));
      group.add(label);
    }
  }

  for (const link of view.links ?? []) {
    const a = currentStructure.residues.get(link.from);
    const b = currentStructure.residues.get(link.to);
    if (!a || !b) continue;
    const pair = closestAtomPair(a, b);
    if (!pair) continue;
    const color = ROLE_COLOR[link.role ?? "neutral"] ?? ROLE_COLOR.neutral;
    const line = new Line(
      new BufferGeometry().setFromPoints([pair.a, pair.b]),
      new LineDashedMaterial({
        color,
        dashSize: 0.45,
        gapSize: 0.35,
        transparent: true,
        opacity: 0.95,
      }),
    );
    line.computeLineDistances();
    group.add(line);
    if (link.label) {
      const mid = pair.a.clone().add(pair.b).multiplyScalar(0.5);
      const label = makeLabel(link.label, color, 1.7);
      label.position.copy(mid).add(new Vector3(0, 1.8, 0));
      group.add(label);
    }
  }

  if (backbone) recolorCartoon(backbone, repaintMap);
  proteinGroup.add(group);
  resultOverlay = group;

  if (view.focus != null) {
    const res = currentStructure.residues.get(view.focus);
    if (res) {
      pickedPos = res.resSeq;
      pickMarker.show(res);
    }
  }
  repaint();
}

// ------------------------------------------------------------- experiments

/** Keep the answer on screen as part of the project record. */
async function saveCurrentAnswer(): Promise<void> {
  const entry = currentAnswer();
  const result = entry?.result;
  if (!result) {
    log("nothing to save — no answer on screen", "warn");
    repaint();
    return;
  }
  if (entry?.example) {
    log("that is a built-in example, not a finding — ask the lab first", "warn");
    projectTab = "log";
    repaint();
    return;
  }

  try {
    const saved = await saveExperiment({
      query: result.query ?? "",
      query_id: result.query_id ?? null,
      headline: result.headline,
      kind: result.kind,
      result: result as unknown as Record<string, unknown>,
    });
    experiments = [saved, ...experiments.filter((e) => e.experiment_id !== saved.experiment_id)];
    log(`saved ${saved.experiment_id}: ${result.headline}`.slice(0, 76));
    projectTab = "experiments";
    projectScroll = 0;
  } catch (error) {
    log(`save failed: ${(error as Error).message}`, "error");
  }
  repaint();
}

/** Reopen a saved experiment: its answer and its molecule, exactly as kept. */
function loadExperiment(experiment_id: string): void {
  const record = experiments.find((e) => e.experiment_id === experiment_id);
  const stored = record?.result as AgentResult | undefined;
  if (!stored) {
    log(`${experiment_id} has no stored view to rebuild`, "warn");
    repaint();
    return;
  }
  const existing = answers.findIndex(
    (a) => !a.example && a.result?.result_id === stored.result_id,
  );
  if (existing >= 0) {
    selectAnswer(existing);
  } else {
    answers.push({ result: stored, prose: "", problem: null });
    selectAnswer(answers.length - 1);
  }
  log(`reopened ${experiment_id}`);
}

async function refreshExperiments(): Promise<void> {
  try {
    const { experiments: saved } = await getExperiments();
    experiments = saved;
  } catch {
    // The project record is not worth failing a poll over.
  }
}

async function removeExperiment(experiment_id: string): Promise<void> {
  try {
    await deleteExperiment(experiment_id);
    experiments = experiments.filter((e) => e.experiment_id !== experiment_id);
    log(`deleted ${experiment_id}`, "warn");
  } catch (error) {
    log(`delete failed: ${(error as Error).message}`, "error");
  }
  repaint();
}

// ---------------------------------------------------------------- lab flow

let healthChecks = 0;
/** Runs already read into an answer, so a finished one is not re-read on every
 * poll. */
const readRuns = new Set<string>();

/**
 * Turn a finished run into something the panel and the molecule can use.
 *
 * The lab is a language model at the other end: it may have followed the format
 * contract, or it may have written prose. Both are handled, and the difference
 * is shown rather than smoothed over — a reply with no JSON block says so.
 */
function ingestRun(run: BridgeRun): void {
  const raw = [run.answer?.headline, run.answer?.conclusion].filter(Boolean).join("\n\n");
  const parsed = parseAnswer(raw);

  let status: QuestionStatus = "answered";
  let entry: AnswerEntry;

  if (parsed.result) {
    const result = parsed.result;
    result.query ??= run.query;
    result.query_id ??= run.query_id;
    entry = { result, prose: parsed.prose, problem: null };
    if (result.kind === "none") status = "empty";
  } else {
    // No contract-shaped block. Keep everything the run did return — headline,
    // citations, the validation numbers — rather than throwing the run away
    // over its formatting.
    status = run.error ? "failed" : "answered";
    const fallback: AgentResult | null = run.answer
      ? {
          result_id: run.query_id,
          query: run.query,
          query_id: run.query_id,
          kind: "none",
          headline: run.answer.headline || "the lab answered without a view",
          summary: run.answer.conclusion ?? parsed.prose,
          confidence: run.validation?.confidence,
          agent_generated: true,
          metrics: (run.validation?.checks ?? []).map((c) => ({
            k: c.name,
            v: `${c.value} (threshold ${c.threshold})`,
            tier: "measured" as const,
            warn: !c.passed,
          })),
          citations: (run.citations ?? []).map((c) => ({
            doc_id: c.doc_id,
            title: c.title,
            year: c.year,
            snippet: c.snippet,
          })),
          view: null,
        }
      : null;
    entry = {
      result: fallback,
      prose: parsed.prose,
      problem: run.error ?? parsed.problem ?? "no JSON block in the reply",
    };
  }

  answers.push(entry);
  selectAnswer(answers.length - 1);

  markQuestion(run.query_id, {
    status,
    headline: entry.result?.headline,
    kind: entry.result?.kind,
    latency_ms: run.latency_ms,
    verdict: run.validation?.verdict ?? null,
  });

  log(
    `answer for ${run.query_id}: ${entry.problem ? `no view (${entry.problem})` : entry.result?.kind}`.slice(0, 76),
    entry.problem ? "warn" : "info",
  );
}

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
      if (!run.finished || readRuns.has(run.query_id)) continue;
      readRuns.add(run.query_id);
      if (run.error) {
        markQuestion(run.query_id, { status: "failed", headline: run.error });
        log(`run ${run.query_id}: ${run.error}`, "error");
        continue;
      }
      ingestRun(run);
    }
  } catch {
    // The bridge is optional: the project record and the viewer work without it.
    activeRun = null;
  }
}

async function poll(): Promise<void> {
  await pollBridge();
  try {
    const { candidates } = await getQueue();
    if (!gateReachable) log("gate api connected");
    gateReachable = true;

    const known = new Set(queue.map((c) => c.candidate_id));
    for (const c of candidates) {
      if (!known.has(c.candidate_id)) {
        // The lab still has the right to stop and ask. There is no gate panel
        // any more, so it lands in the log where it cannot be missed.
        log(`lab asks for review: ${c.kind} ${c.candidate_id} (${c.source}) — keys 1/2/3`, "warn");
      }
    }
    queue = candidates;
    await refreshExperiments();
    repaint();
  } catch (error) {
    gateReachable = false;
    log(`gate api unreachable: ${(error as Error).message}`, "error");
    setStatus(`gate api unreachable — ${(error as Error).message}`, "error");
    repaint();
  }
}

/**
 * Decide the oldest flagged candidate.
 *
 * The lab blocks on `request_human_review`, so a flagged candidate with nobody
 * to answer it stalls the whole run. Keyboard-only is thin, but losing the
 * human's half of the loop entirely is not an option.
 */
async function decide(decision: DecisionKind): Promise<void> {
  const target = queue[0];
  if (!target) return;
  try {
    await postDecision(target.candidate_id, decision);
    queue = queue.slice(1);
    log(`${decision} ${target.candidate_id}${target.approval_id ? " → relayed to lab" : ""}`);
    setStatus(`${decision} sent for ${target.candidate_id}`);
  } catch (error) {
    log(`decision failed: ${(error as Error).message}`, "error");
  }
  repaint();
}

// ---------------------------------------------------------------- picking

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
    pickedPos = null;
    pickMarker.hide();
    repaint();
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
  log(`picked ${res.resName} ${res.resSeq}`);
  repaint();
}

/** Double-press to delete, like renaming used to be: the first press arms it. */
let armedDelete: string | null = null;

function handleAction(id: string): void {
  const [kind, value, rest] = id.split(":");
  switch (kind) {
    case "project":
      if (value === "tab") {
        projectTab = (rest as ProjectTab) ?? "questions";
        projectScroll = 0;
        armedDelete = null;
      } else if (value === "scroll") {
        const step = rest === "up" ? -SCROLL_STEP : SCROLL_STEP;
        projectScroll = Math.min(
          Math.max(projectScroll + step, 0),
          projectPanel.maxScroll,
        );
      } else if (value === "save") {
        void saveCurrentAnswer();
        return;
      } else if (value === "open") {
        // Jump to the answer this question produced, if it has one.
        const found = answers.findIndex((a) => a.result?.query_id === rest);
        if (found >= 0) selectAnswer(found);
        else log("that question has no answer yet", "warn");
      } else if (value === "load") {
        // First press reopens it; a second press on an already-open experiment
        // is a delete, which still needs confirming.
        if (armedDelete === rest) {
          armedDelete = null;
          void removeExperiment(rest);
          return;
        }
        loadExperiment(rest);
      }
      repaint();
      return;

    case "console":
      if (value === "ask") {
        if (voice.state === "recording") void endVoice();
        else void beginVoice();
      } else if (value === "send") {
        void sendQuestion();
      } else if (value === "clear") {
        voice.lastText = "";
        voice.lastError = null;
        repaint();
      }
      return;

    case "answer":
      if (value === "deep") {
        answerDeep = !answerDeep;
        answerScroll = 0;
      } else if (value === "scroll") {
        const step = rest === "up" ? -SCROLL_STEP : SCROLL_STEP;
        answerScroll = Math.min(Math.max(answerScroll + step, 0), answerPanel.maxScroll);
      } else if (value === "prev" || value === "next") {
        if (answers.length === 0) return;
        const step = value === "prev" ? -1 : 1;
        selectAnswer((answerIndex + step + answers.length) % answers.length);
        return;
      }
      repaint();
      return;

    case "gate":
      if (value === "recenter") resetLayout();
      return;
  }
}

const panelGroups = [
  projectPanel.group,
  answerPanel.group,
  consolePanel.group,
  controlBar.group,
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
 * button would fling the panel across the room. In VR grip and trigger are
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
 * `visible` is false — it only skips them at render time. Without this filter a
 * hidden surface between the viewer and the molecule silently swallows every
 * grab aimed at the structure.
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
  if (event.key === "r") resetLayout();
  if (event.key === "d") {
    answerDeep = !answerDeep;
    answerScroll = 0;
    repaint();
  }
  if (event.key === "s") void saveCurrentAnswer();
  if (event.key === "ArrowRight") handleAction("answer:next");
  if (event.key === "ArrowLeft") handleAction("answer:prev");
  if (event.key === "v" && !event.repeat) void beginVoice();
  if (event.key === "Escape") {
    pickedPos = null;
    pickMarker.hide();
    repaint();
  }
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
  // No setReferenceSpaceType here: three already defaults to `local-floor`,
  // and the call only takes effect before setSession — afterwards it warns
  // "Cannot change reference space type while presenting" and does nothing.
  await renderer.xr.setSession(session);

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
    setDesktopBackdrop();
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

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.1);

  input.update(renderer.xr.getSession(), delta);
  if (!renderer.xr.isPresenting) controls.update();

  if (pendingRecenterFrames > 0 && renderer.xr.isPresenting) {
    pendingRecenterFrames--;
    if (pendingRecenterFrames === 0) recenterLayout();
  }

  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- boot

void (async () => {
  setStatus("connecting to gate api…");
  recenterLayout();
  log("viewer started");
  repaint();

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
    gateReachable = true;
    setStatus(`${config.protein_id} ${config.structure_id} loaded · ask the console`);
    log(`${config.protein_id} ${config.structure_id} loaded`);
  } catch (error) {
    gateReachable = false;
    log(`boot failed: ${(error as Error).message}`, "error");
    setStatus(`gate api unreachable — ${(error as Error).message}`, "error");
  }

  await refreshExperiments();
  log(`${experiments.length} saved experiment${experiments.length === 1 ? "" : "s"} on the gate`);
  repaint();

  await poll();
})();

// Polling lives on a timer, not in the render loop: a backgrounded tab (or a
// headset that has gone to sleep) parks requestAnimationFrame, and the lab must
// keep being tracked regardless.
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
