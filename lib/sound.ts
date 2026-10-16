let audio: AudioContext | null = null;

function context() {
  if (typeof window === "undefined") return null;
  if (!audio) audio = new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

export function unlockSound() {
  context();
}

function tone(frequency: number, duration: number, delay = 0, type: OscillatorType = "sine", volume = 0.045) {
  const ctx = context();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function playClick() {
  tone(720, 0.05, 0, "triangle", 0.03);
}

export function playMark() {
  tone(523, 0.12, 0, "sine", 0.05);
  tone(784, 0.18, 0.09, "sine", 0.04);
}

export function playGrace() {
  tone(311, 0.16, 0, "triangle", 0.04);
  tone(247, 0.22, 0.12, "triangle", 0.035);
}

export function playAbsent() {
  tone(196, 0.22, 0, "sine", 0.05);
  tone(131, 0.32, 0.16, "sine", 0.04);
}

export function playForReason(reason: string) {
  if (reason === "marked" || reason === "present") playMark();
  else if (reason === "grace") playGrace();
  else if (reason === "absent") playAbsent();
}
