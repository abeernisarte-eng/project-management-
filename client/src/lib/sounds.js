// Notification sound engine. Tones are synthesized with the Web Audio API
// (no assets to load); a custom ringtone uploaded in Settings is stored as a
// data URL and played through an HTMLAudioElement. Browser autoplay rules are
// respected by priming the AudioContext on the first user interaction (the
// pointerdown listener lives in NotificationContext / SettingsPage).

export const TONES = [
  { id: "chime", name: "Chime (default)", wave: "sine", notes: [[880, 0], [1174.66, 0.16]] },
  { id: "bell", name: "Bell", wave: "sine", notes: [[1318.5, 0], [1046.5, 0.22]] },
  { id: "ping", name: "Ping", wave: "triangle", notes: [[1760, 0]] },
  { id: "marimba", name: "Marimba", wave: "triangle", notes: [[523.25, 0], [659.25, 0.12], [783.99, 0.24]] },
  { id: "alert", name: "Alert", wave: "square", notes: [[660, 0], [660, 0.22], [660, 0.44]] },
];

export const DEFAULT_TONE = "chime";

let audioCtx = null;

export function primeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {
    // No audio available in this environment.
  }
}

export function getToneName(toneId) {
  return (TONES.find((t) => t.id === toneId) || TONES[0]).name;
}

function synthTone(toneId, volume) {
  const tone = TONES.find((t) => t.id === toneId) || TONES[0];
  const t = audioCtx.currentTime;
  const gainScale = Math.max(0, Math.min(1, volume)) * 0.25;
  tone.notes.forEach(([freq, offset], i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = tone.wave;
    osc.frequency.value = freq;
    const start = t + offset;
    const dur = i === tone.notes.length - 1 ? 0.42 : 0.18;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainScale, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  });
}

function playCustom(dataUrl, volume) {
  const audio = new Audio(dataUrl);
  audio.volume = Math.max(0, Math.min(1, volume));
  audio.play().catch(() => {
    // Autoplay blocked or decode failure — best effort only.
  });
}

// Play a notification sound for the given settings slice
// ({ enabled, tone, volume, customAudio }). Silent no-op when disabled.
export function playNotificationSound(sound) {
  if (!sound || !sound.enabled) return;
  try {
    primeAudio();
    if (sound.customAudio) {
      playCustom(sound.customAudio, (sound.volume ?? 60) / 100);
      return;
    }
    if (!audioCtx || audioCtx.state !== "running") return;
    synthTone(sound.tone, (sound.volume ?? 60) / 100);
  } catch {
    // Sound is best-effort; never break polling over it.
  }
}

// Standalone preview (Settings page Play button) — primes + plays regardless
// of the sound-enabled toggle, since the user explicitly asked for it.
export function previewSound(sound) {
  try {
    primeAudio();
    if (sound.customAudio) {
      playCustom(sound.customAudio, (sound.volume ?? 60) / 100);
      return;
    }
    if (!audioCtx || audioCtx.state !== "running") return;
    synthTone(sound.tone || DEFAULT_TONE, (sound.volume ?? 60) / 100);
  } catch {
    // Best effort.
  }
}
