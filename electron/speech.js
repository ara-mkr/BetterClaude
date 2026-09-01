/**
 * macOS push-to-talk speech-to-text for the Code IDE chat composer.
 *
 * The IDE window's CSP (`default-src 'none'`) blocks every renderer-side path
 * to a transcriber — no network, no Web Workers, no WebAssembly — and
 * Electron's `webkitSpeechRecognition` has no backend. So the renderer only
 * captures microphone audio (getUserMedia), encodes a 16 kHz mono WAV in
 * plain JS, and ships the bytes here over IPC; this main-process module runs
 * the actual recognition with whisper.cpp and returns text.
 *
 * whisper.cpp's CLI is expected on PATH (`brew install whisper-cpp` gives you
 * `whisper-cli`). Only the model file is fetched by this module — that URL is
 * stable, a prebuilt cross-arch binary is not — into
 * `<userData>/whisper/ggml-base.en.bin` on first use.
 *
 * Never touches Claude credentials, claude.ai, or the pty session. No calls
 * out except the one model download.
 */

const { app } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const MODEL_MIN_BYTES = 100 * 1024 * 1024; // a truncated download is smaller than this
const CLI_NAMES = ["whisper-cli", "whisper-cpp", "whisper"];
const CLI_HINTS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
];

let cachedCliPath = null;
let modelDownload = null; // in-flight Promise, so concurrent first-uses share it

function whisperDir() {
  return path.join(app.getPath("userData"), "whisper");
}

function modelPath() {
  return path.join(whisperDir(), "ggml-base.en.bin");
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Locates a whisper.cpp CLI: explicit override, then PATH, then Homebrew dirs. */
function locateCli() {
  if (cachedCliPath && isExecutable(cachedCliPath)) return cachedCliPath;
  cachedCliPath = null;

  const override = process.env.BC_WHISPER_CLI;
  if (override && isExecutable(override)) return (cachedCliPath = override);

  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...CLI_HINTS]) {
    for (const name of CLI_NAMES) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return (cachedCliPath = candidate);
    }
  }
  return null;
}

function modelPresent() {
  try {
    return fs.statSync(modelPath()).size >= MODEL_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Whether push-to-talk can work on this machine right now.
 * `{ available, needsModelDownload, reason }`.
 */
function status() {
  if (process.platform !== "darwin") {
    return { available: false, reason: "Voice input is macOS-only for now." };
  }
  if (!locateCli()) {
    return {
      available: false,
      reason: "whisper.cpp not found — install it with `brew install whisper-cpp`.",
    };
  }
  return { available: true, needsModelDownload: !modelPresent() };
}

async function ensureModel() {
  if (modelPresent()) return modelPath();
  if (modelDownload) return modelDownload;

  modelDownload = (async () => {
    fs.mkdirSync(whisperDir(), { recursive: true });
    const tmp = `${modelPath()}.downloading`;
    const res = await fetch(MODEL_URL);
    if (!res || !res.ok || !res.body) {
      throw new Error(`Could not download the speech model (HTTP ${res && res.status}).`);
    }
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      Readable.fromWeb(res.body).pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
    });
    if (fs.statSync(tmp).size < MODEL_MIN_BYTES) {
      fs.unlinkSync(tmp);
      throw new Error("The speech model download was incomplete — try again.");
    }
    fs.renameSync(tmp, modelPath());
    return modelPath();
  })().finally(() => { modelDownload = null; });

  return modelDownload;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(locateCli(), args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error((err.message || "whisper failed").trim()));
      else resolve(stdout);
    });
  });
}

/**
 * Transcribes a WAV buffer (expected 16 kHz mono PCM, as the renderer encodes
 * it) and returns the recognized text. Writes the WAV to a temp file because
 * every whisper.cpp CLI variant takes a file path, not stdin.
 */
async function transcribe(wavBuffer) {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
    throw new Error("No audio was captured.");
  }
  if (!locateCli()) throw new Error(status().reason);
  const model = await ensureModel();

  const base = path.join(os.tmpdir(), `bc-stt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const wavFile = `${base}.wav`;
  const txtFile = `${base}.wav.txt`; // whisper.cpp writes "<input>.txt"
  fs.writeFileSync(wavFile, wavBuffer);

  try {
    await runCli(["-m", model, "-f", wavFile, "-otxt", "-nt", "-np", "-l", "en"]);
    let text = "";
    try { text = fs.readFileSync(txtFile, "utf8"); } catch {}
    return text.replace(/\s+/g, " ").trim();
  } finally {
    for (const f of [wavFile, txtFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

module.exports = { status, transcribe, ensureModel };
