
'use strict';

// THE LAST CALL — THE LISTENER SOUND ENGINE
// Synthetic beta audio — no extra dependencies

const SR = 16000;
const TWO_PI = Math.PI * 2;
const cache = new Map();

const durations = {
  knocks: 2.2,
  scrape: 3.1,
  footsteps: 3.0,
  drone: 9.0,
  attack: 2.0,
  death: 3.4,
  green: 0.2,
  red: 0.5,
  success: 1.4
};

const tone = (f, t) =>
  Math.sin(TWO_PI * f * t);

const noise = n => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
};

const hit = (t, start, decay) =>
  t < start ? 0 : Math.exp(-(t - start) * decay);

function sample(name, t, n, duration) {
  let s = 0;

  if (name === 'knocks') {
    for (const at of [0.16, 0.80, 1.59]) {
      const h = hit(t, at, 24);
      s += h * (
        0.5 * tone(410, t - at) +
        0.22 * noise(n)
      );
    }
  }

  if (name === 'scrape') {
    const a = Math.sin(Math.PI * t / duration) ** 2;
    s = a * (
      0.28 * tone(780 - 105 * t, t) +
      0.28 * noise(n) *
      (0.5 + 0.5 * tone(14, t))
    );
  }

  if (name === 'footsteps') {
    for (const at of [0.25, 0.9, 1.6, 2.35]) {
      const h = hit(t, at, 18);
      s += h * (
        0.36 * tone(330, t - at) +
        0.2 * noise(n)
      );
    }
  }

  if (name === 'drone') {
    const a =
      Math.min(1, t * 1.5) *
      Math.min(1, (duration - t) * 1.8);

    s = a * (
      0.10 * tone(
        327 + 9 * Math.sin(t * 0.67), t
      ) +
      0.07 * tone(
        493 + 13 * Math.sin(t * 0.23), t
      ) +
      0.025 * noise(n)
    );
  }

  if (name === 'attack') {
    const a = hit(t, 0.08, 2.3);
    s = a * (
      0.40 * noise(n) +
      0.20 * tone(900 - 270 * t, t)
    );
  }

  if (name === 'death') {
    const a =
      Math.sin(Math.PI *
      Math.min(1, t / duration)) ** 2;

    s = a * (
      0.25 * noise(n) *
      (0.6 + 0.4 * tone(10, t)) +
      0.15 * tone(460 - 85 * t, t)
    );
  }

  if (name === 'green') {
    s = 0.30 * Math.exp(-t * 14) *
      (tone(880, t) + 0.3 * tone(1320, t));
  }

  if (name === 'red') {
    s = 0.30 * Math.exp(-t * 5) *
      (tone(260, t) + 0.45 * tone(310, t));
  }

  if (name === 'success') {
    for (const [at, f] of [
      [0.05, 523], [0.33, 659], [0.62, 784]
    ]) {
      s += 0.26 * hit(t, at, 4.5) *
        tone(f, t - at);
    }
  }

  return Math.max(
    -0.95, Math.min(0.95, s)
  );
}

function generate(name) {
  const seconds = durations[name];
  if (!seconds) return null;

  const count = Math.round(seconds * SR);
  const dataSize = count * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SR, 24);
  wav.writeUInt32LE(SR * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < count; i++) {
    wav.writeInt16LE(
      Math.round(
        sample(name, i / SR, i, seconds) * 32767
      ),
      44 + i * 2
    );
  }

  return wav;
}

function getListenerSound(name) {
  if (!durations[name]) return null;

  if (!cache.has(name)) {
    cache.set(name, generate(name));
  }

  return cache.get(name);
}

module.exports = { getListenerSound };
