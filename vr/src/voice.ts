/**
 * Spoken questions from the headset.
 *
 * Quest Browser has no Web Speech API — checked on the device: no
 * `SpeechRecognition` (prefixed or not) and no `speechSynthesis`. It does have
 * `getUserMedia` and `MediaRecorder` with opus/webm, so the viewer records a
 * clip and the gate transcribes it. No key ever reaches the frontend.
 *
 * The microphone stream is opened once, on the first press, and kept. Opening
 * it costs a permission prompt, and a prompt raised in the middle of an
 * immersive session is somewhere between awkward and invisible — so the first
 * press should happen before entering XR, and after that the stream is warm.
 */

export type VoiceState = "idle" | "recording" | "sending" | "error";

export interface VoiceResult {
  ok: boolean;
  text: string;
  query_id?: string;
  reason?: string;
}

/** Picked from what the browser will actually encode, opus first. */
function pickMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return undefined;
}

export class VoiceInput {
  state: VoiceState = "idle";
  /** Last thing the gate heard, shown in-world so a misheard question is visible. */
  lastText = "";
  lastError: string | null = null;
  /** True while a transcript is being handed to the agent lab. */
  dispatching = false;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(private onChange: () => void) {}

  get supported(): boolean {
    return (
      typeof MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia
    );
  }

  /** Open the mic. Must be called from a user gesture the first time. */
  private async ensureStream(): Promise<MediaStream> {
    if (this.stream && this.stream.active) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return this.stream;
  }

  async start(): Promise<void> {
    if (this.state === "recording" || this.state === "sending") return;
    this.lastError = null;
    try {
      const stream = await this.ensureStream();
      const mimeType = pickMimeType();
      this.chunks = [];
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      this.recorder.start();
      this.state = "recording";
    } catch (error) {
      this.state = "error";
      this.lastError =
        (error as Error).name === "NotAllowedError"
          ? "microphone permission denied"
          : `microphone unavailable: ${(error as Error).message}`;
    }
    this.onChange();
  }

  /**
   * Stop recording and upload the clip for transcription. Resolves with what
   * the gate heard, or null when there was nothing worth sending.
   */
  async stopAndSend(): Promise<VoiceResult | null> {
    const recorder = this.recorder;
    if (!recorder || this.state !== "recording") return null;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });
    this.recorder = null;

    // A tap rather than a hold produces a few hundred bytes of silence; sending
    // it just burns an API call to be told nothing was said.
    if (blob.size < 2000) {
      this.state = "idle";
      this.lastError = "too short — hold while you speak";
      this.onChange();
      return null;
    }

    this.state = "sending";
    this.onChange();

    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      // Transcribe only: the reviewer sees the text and presses Send to lab.
      form.append("explore", "false");
      const response = await fetch("/voice/ask", { method: "POST", body: form });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail.slice(0, 160));
      }
      const result = (await response.json()) as VoiceResult;
      this.lastText = result.text || "";
      this.lastError = result.ok ? null : (result.reason ?? "nothing recognised");
      this.state = "idle";
      this.onChange();
      return result;
    } catch (error) {
      this.state = "error";
      this.lastError = (error as Error).message;
      this.onChange();
      return null;
    }
  }

  /** Release the mic — the recording indicator in the OS should go out. */
  dispose(): void {
    this.recorder?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.state = "idle";
  }
}

export interface VoiceHealth {
  configured: boolean;
  model: string;
}

/** Can the gate transcribe at all? Lets the UI grey the control out. */
export async function voiceHealth(): Promise<VoiceHealth> {
  const response = await fetch("/voice/health");
  if (!response.ok) throw new Error(`GET /voice/health → ${response.status}`);
  return response.json() as Promise<VoiceHealth>;
}
