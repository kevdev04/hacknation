/**
 * How the molecule moves when nobody is touching it.
 *
 * Two things, both of which must get out of the way the instant a hand arrives:
 *
 *   **The turntable.** A slow spin about the structure's own axis — about one
 *   revolution a minute, slow enough to read as alive rather than as motion.
 *   It is there so a protein left alone still shows its depth; it is not there
 *   to be fought with.
 *
 *   **The assembly.** When the answer changes, the fold threads itself back
 *   together N→C rather than cutting. It runs as a single shader uniform
 *   (`setAssembly` in `protein.ts`), so a 263-residue ribbon costs one write a
 *   frame.
 *
 * Everything here is framerate-independent and allocation-free: this runs
 * inside the render loop on a Quest 3S.
 */

/** Radians per second at full speed — a turn takes about a minute. */
const SPIN_SPEED = 0.105;
/** How long the spin takes to reach full speed once it is allowed to. */
const SPIN_RAMP_S = 1.6;
/** How fast it gives up when touched. Short enough to read as "it stopped". */
const SPIN_STOP_S = 0.12;
/** Quiet time after the last touch before the turntable creeps back in. */
const RESUME_AFTER_S = 3.0;

/** How long a full assembly takes. Long enough to watch, short enough to wait. */
const ASSEMBLE_S = 1.15;

export class Motion {
  /** 0-1 of `SPIN_SPEED`, eased rather than switched. */
  private spin = 0;
  /** Seconds since the molecule was last touched. */
  private quiet = RESUME_AFTER_S;
  /** True while a hand is on it — no ramp back while that is the case. */
  private handsOn = false;

  /** 0 scattered, 1 built. Starts built so a still frame is never mid-air. */
  private assembly = 1;
  private assembling = false;

  /**
   * The user has the molecule. This is a per-frame assertion, not a latch:
   * `update` clears it, so a hand that lets go needs no release event.
   */
  hold(): void {
    this.handsOn = true;
  }

  /** The user touched it — a scale, a drag, a release. Not a continuous hold. */
  touch(): void {
    this.handsOn = false;
    this.quiet = 0;
  }

  /** Start the fold threading itself back together. */
  assemble(): void {
    this.assembly = 0;
    this.assembling = true;
    // An assembly is the molecule's own moment; it should not also be turning
    // out from under the thing the answer is pointing at.
    this.spin = 0;
    this.quiet = 0;
  }

  get isAssembling(): boolean {
    return this.assembling;
  }

  /** Progress for `setAssembly`, and for anything that should arrive with it. */
  get assemblyProgress(): number {
    return this.assembly;
  }

  /**
   * Advance by `delta` seconds and return the yaw to apply this frame, in
   * radians. Zero while held, while assembling, and until the ramp has started.
   */
  update(delta: number): number {
    if (this.assembling) {
      this.assembly = Math.min(1, this.assembly + delta / ASSEMBLE_S);
      if (this.assembly >= 1) this.assembling = false;
    }

    if (this.handsOn) this.quiet = 0;
    else this.quiet += delta;

    const wanted =
      this.handsOn || this.assembling || this.quiet < RESUME_AFTER_S ? 0 : 1;
    const ramp = delta / (wanted > this.spin ? SPIN_RAMP_S : SPIN_STOP_S);
    this.spin += Math.sign(wanted - this.spin) * Math.min(ramp, Math.abs(wanted - this.spin));

    // Cleared every frame: holding has to be re-asserted, so letting go of the
    // molecule needs no release event to be noticed.
    this.handsOn = false;

    // Smoothstep the ramp so neither end of it is a corner.
    const eased = this.spin * this.spin * (3 - 2 * this.spin);
    return eased * SPIN_SPEED * delta;
  }
}
