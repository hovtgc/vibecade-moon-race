export type EngineAudio = {
  unlock: () => void;
  update: (speed: number, boost: number) => void;
  impact: (amount: number) => void;
  boost: () => void;
  gate: () => void;
  jug: () => void;
};

export function createAudio(): EngineAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let engine: OscillatorNode | null = null;
  let engineGain: GainNode | null = null;
  let filter: BiquadFilterNode | null = null;

  function unlock() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.4;
      master.connect(ctx.destination);
      engine = ctx.createOscillator();
      engine.type = "sawtooth";
      engine.frequency.value = 52;
      filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 280;
      engineGain = ctx.createGain();
      engineGain.gain.value = 0.0001;
      engine.connect(filter);
      filter.connect(engineGain);
      engineGain.connect(master);
      engine.start();
    }
    if (ctx.state === "suspended") void ctx.resume();
  }

  function burst(freq: number, dur: number, type: OscillatorType, vol: number) {
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(g);
    g.connect(master);
    osc.start();
    osc.stop(ctx.currentTime + dur + 0.02);
  }

  return {
    unlock,
    update(speed, boost) {
      if (!ctx || !engine || !engineGain || !filter) return;
      const vol = Math.min(0.07, 0.008 + Math.abs(speed) * 0.0018 + (boost > 0 ? 0.02 : 0));
      engineGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.05);
      engine.frequency.setTargetAtTime(46 + Math.abs(speed) * 2.8 + (boost > 0 ? 36 : 0), ctx.currentTime, 0.06);
      filter.frequency.setTargetAtTime(220 + Math.abs(speed) * 18, ctx.currentTime, 0.08);
    },
    impact(amount) {
      if (amount < 3) return;
      burst(70 + Math.min(40, amount), 0.22, "triangle", Math.min(0.2, amount * 0.012));
    },
    boost() {
      burst(180, 0.28, "square", 0.05);
    },
    gate() {
      burst(520, 0.09, "sine", 0.04);
    },
    jug() {
      burst(660, 0.08, "sine", 0.045);
      burst(880, 0.12, "triangle", 0.03);
    },
  };
}
