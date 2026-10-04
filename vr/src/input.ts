/**
 * Quest controller input: grab/place on grip, scale on thumbstick, residue
 * picking and panel presses on trigger, and the A/B/X decision buttons.
 *
 * The grip picks up whatever the ray is pointing at — a panel or the protein —
 * so the whole workspace can be arranged around the wearer. Each hand tracks
 * its own held object, so one hand can hold the structure while the other
 * repositions a panel.
 *
 * Button indices follow the WebXR `xr-standard` gamepad mapping used by the
 * Meta Touch controllers: 1 squeeze, 3 thumbstick click, 4 primary face button
 * (A right / X left), 5 secondary (B right / Y left). The trigger is handled as
 * a select event instead, so the same code path serves tracked hands.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Raycaster,
  RingGeometry,
  Vector3,
  type WebGLRenderer,
  type XRTargetRaySpace,
} from "three";
import type { DecisionKind } from "./api";

const BTN_SQUEEZE = 1;
const BTN_THUMBSTICK = 3;
const BTN_PRIMARY = 4; // A (right) / X (left)
const BTN_SECONDARY = 5; // B (right) / Y (left)

export interface XRInputCallbacks {
  onDecision: (decision: DecisionKind) => void;
  onPick: (ray: Raycaster) => void;
  /** `held` is the object in this hand, or null when nothing is grabbed. */
  onScale: (factor: number, held: Object3D | null) => void;
  /**
   * What this ray should pick up, or null to grab nothing. `gripPosition` lets
   * the caller fall back to the nearest object when the ray hits nothing, so a
   * squeeze is never a no-op just because the aim was off.
   */
  resolveGrab: (ray: Raycaster, gripPosition: Vector3) => Object3D | null;
  /**
   * The grab bar under this ray, if any. A pinch or trigger that lands on a
   * handle moves the surface; anything else is a press.
   */
  resolveHandle: (ray: Raycaster) => Object3D | null;
  /** Put every placeable object back where it started. */
  onReset: () => void;
  /** Push-to-talk: left-hand Y held down, then released. */
  onVoiceStart: () => void;
  onVoiceEnd: () => void;
}

interface ControllerState {
  grip: Group;
  ray: XRTargetRaySpace;
  /** Ring on the grip, lit while this hand is holding something. */
  marker: Mesh<any, MeshBasicMaterial>;
  handedness: "left" | "right" | "none";
  /** True when this input source is a tracked hand rather than a controller. */
  isHand: boolean;
  pressed: Set<number>;
  grabbed: Object3D | null;
  /** Where the grabbed object came from, so release can put it back. */
  grabOrigin: Object3D | null;
  /** Which input started the hold, so only that input can end it. */
  heldBy: HoldSource | null;
}

/** Squeeze grabs anything; select (trigger / hand pinch) grabs only handles. */
type HoldSource = "squeeze" | "select";

const GRIP_IDLE = 0x45586c;
const GRIP_HOLDING = 0x7aa2ff;

export class XRInput {
  private controllers: ControllerState[] = [];
  private raycaster = new Raycaster();
  private tmpMatrix = new Matrix4();
  private tmpVector = new Vector3();
  /** Objects currently in a hand, so two grips cannot fight over one panel. */
  private held = new Set<Object3D>();

  constructor(
    private renderer: WebGLRenderer,
    private scene: Object3D,
    private callbacks: XRInputCallbacks,
  ) {
    for (let i = 0; i < 2; i++) {
      const ray = renderer.xr.getController(i);
      ray.add(buildRayLine());
      ray.add(buildCursor());
      scene.add(ray);

      const grip = renderer.xr.getControllerGrip(i);
      const marker = buildGripMarker();
      grip.add(marker);
      scene.add(grip);

      const state: ControllerState = {
        grip,
        ray,
        marker,
        handedness: "none",
        isHand: false,
        pressed: new Set(),
        grabbed: null,
        grabOrigin: null,
        heldBy: null,
      };
      ray.addEventListener("connected", (event: any) => {
        state.handedness = event.data?.handedness ?? "none";
        state.isHand = !!event.data?.hand;
      });

      // WebXR raises select for a controller trigger AND a hand pinch, so this
      // is the one input path that works without a gamepad. Hand input sources
      // expose no `gamepad` at all, which is why the polling loop below cannot
      // see them.
      ray.addEventListener("selectstart", () =>
        this.guard("selectstart", () => this.onSelectStart(state)),
      );
      ray.addEventListener("selectend", () =>
        this.guard("selectend", () => this.endHold(state, "select")),
      );
      ray.addEventListener("disconnected", () => {
        state.handedness = "none";
        state.isHand = false;
        state.pressed.clear();
        this.releaseAny(state);
      });
      this.controllers.push(state);
    }
  }

  /** Call once per frame, before rendering. */
  update(session: XRSession | null, delta: number): void {
    if (!session) return;

    for (const state of this.controllers) {
      const source = [...session.inputSources].find(
        (s) => s.handedness === state.handedness && s.gamepad,
      );
      const pad = source?.gamepad;
      if (!pad) continue;

      // Edge-triggered buttons
      // BTN_TRIGGER is deliberately absent: it arrives as a select event, so
      // polling it too would fire every press twice.
      for (const index of [
        BTN_SQUEEZE,
        BTN_THUMBSTICK,
        BTN_PRIMARY,
        BTN_SECONDARY,
      ]) {
        const down = !!pad.buttons[index]?.pressed;
        const was = state.pressed.has(index);
        if (down && !was) {
          state.pressed.add(index);
          this.guard("press", () => this.onPress(state, index));
        } else if (!down && was) {
          state.pressed.delete(index);
          this.guard("release", () => this.onRelease(state, index));
        }
      }

      // Thumbstick Y scales whatever this hand is holding, falling back to the
      // structure. Dead zone so resting drift does nothing.
      const stickY = pad.axes[3] ?? 0;
      if (Math.abs(stickY) > 0.2) {
        this.callbacks.onScale(Math.exp(-stickY * delta * 1.6), state.grabbed);
      }
    }
  }

  /**
   * One bad frame must not take the whole session down with it. An exception
   * thrown inside a button handler used to escape into the render loop and
   * leave every control dead with no visible cause.
   */
  private guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error(`[xr-input] ${label} failed`, error);
    }
  }

  private onPress(state: ControllerState, index: number): void {
    switch (index) {
      case BTN_SQUEEZE:
        this.grab(state);
        break;
      case BTN_THUMBSTICK:
        this.callbacks.onReset();
        break;
      case BTN_PRIMARY:
        // A on the right hand approves; X on the left hand defers.
        this.callbacks.onDecision(state.handedness === "left" ? "defer" : "approve");
        break;
      case BTN_SECONDARY:
        // B on the right hand rejects; Y on the left is the only face button
        // left free, so it is push-to-talk.
        if (state.handedness === "left") this.callbacks.onVoiceStart();
        else this.callbacks.onDecision("reject");
        break;
    }
  }

  private onRelease(state: ControllerState, index: number): void {
    if (index === BTN_SQUEEZE) this.endHold(state, "squeeze");
    if (index === BTN_SECONDARY && state.handedness === "left") {
      this.callbacks.onVoiceEnd();
    }
  }

  /**
   * A pinch or trigger on a grab bar moves that surface; anywhere else it is a
   * press. The handles are what make this unambiguous for hands, which have no
   * second button to separate the two.
   */
  private onSelectStart(state: ControllerState): void {
    const ray = this.rayFrom(state);
    const handle = this.callbacks.resolveHandle(ray);
    if (handle) {
      this.beginHold(state, handle, "select");
      return;
    }
    this.callbacks.onPick(ray);
  }

  private rayFrom(state: ControllerState): Raycaster {
    // Sprite.raycast dereferences raycaster.camera, and the residue labels on
    // the structure are sprites. The desktop path gets a camera for free via
    // setFromCamera; building the ray by hand does not, and without this the
    // whole intersect call throws the moment the molecule is in range.
    this.raycaster.camera = this.renderer.xr.getCamera();
    this.tmpMatrix.identity().extractRotation(state.ray.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(state.ray.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix);
    return this.raycaster;
  }

  /** Squeeze: pick up whatever the ray hit, or the nearest thing in reach. */
  private grab(state: ControllerState): void {
    if (state.grabbed) return;
    state.grip.getWorldPosition(this.tmpVector);
    const target = this.callbacks.resolveGrab(this.rayFrom(state), this.tmpVector);
    this.beginHold(state, target, "squeeze");
  }

  /**
   * Reparent to the hand that took it, preserving its world transform. Holds
   * attach to the target ray space rather than the grip, because a tracked hand
   * has no grip space of its own.
   *
   * `attach` does the change-of-basis itself. Doing it by hand with
   * `applyMatrix4` is a trap: that method multiplies by the object's own local
   * matrix, so passing a matrix already built from its world transform applies
   * the transform twice and the object rockets away on every grab.
   */
  private beginHold(
    state: ControllerState,
    target: Object3D | null,
    source: HoldSource,
  ): void {
    if (!target || state.grabbed || this.held.has(target)) return;

    const anchor = state.isHand ? state.ray : state.grip;
    state.grabOrigin = target.parent ?? this.scene;
    anchor.attach(target);

    state.grabbed = target;
    state.heldBy = source;
    state.marker.material.color.setHex(GRIP_HOLDING);
    this.held.add(target);
  }

  /** Only the input that started the hold may end it. */
  private endHold(state: ControllerState, source: HoldSource): void {
    if (state.heldBy !== source) return;
    this.releaseAny(state);
  }

  private releaseAny(state: ControllerState): void {
    const grabbed = state.grabbed;
    if (!grabbed) return;

    (state.grabOrigin ?? this.scene).attach(grabbed);

    this.held.delete(grabbed);
    state.marker.material.color.setHex(GRIP_IDLE);
    state.grabbed = null;
    state.grabOrigin = null;
    state.heldBy = null;
  }

  /** Is this object in someone's hand right now? */
  isHeld(object: Object3D): boolean {
    return this.held.has(object);
  }

  /** Drop everything — used before the layout is rebuilt under the user. */
  releaseAll(): void {
    for (const state of this.controllers) this.releaseAny(state);
  }
}

function buildRayLine(): Line {
  const geometry = new BufferGeometry().setFromPoints([
    new Vector3(0, 0, 0),
    new Vector3(0, 0, -1),
  ]);
  const line = new Line(
    geometry,
    new LineBasicMaterial({ color: 0x7fd1c1, transparent: true, opacity: 0.6 }),
  );
  line.name = "ray";
  line.scale.z = 3;
  return line;
}

function buildCursor(): Mesh {
  const mesh = new Mesh(
    new RingGeometry(0.008, 0.013, 24),
    new MeshBasicMaterial({
      color: 0x7fd1c1,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  mesh.position.z = -0.6;
  return mesh;
}

function buildGripMarker(): Mesh<any, MeshBasicMaterial> {
  return new Mesh(
    new RingGeometry(0.018, 0.026, 20),
    new MeshBasicMaterial({ color: GRIP_IDLE, transparent: true, opacity: 0.9 }),
  );
}
