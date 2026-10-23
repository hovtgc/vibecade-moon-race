import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { VibeCadeClient } from "vibecade-sdk";
import { Droplets, Flag, Gauge, RotateCcw, Timer, Zap } from "lucide-react";
import * as THREE from "three";
import { createAudio } from "./audio";
import { isRealHost, openSession } from "./session";
import { createWorld, updateWorld, type GhostPose, type World } from "./scene";
import { createSim, formatTime, KeyInput, scoreOf, stepSim, type Sim } from "./sim";
import { buildTrack, querySurface } from "./track";
import "./probe";

const SAVE_KEY = "moon-race.v1";

function readBest() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { bestMs?: number };
    return typeof parsed.bestMs === "number" ? parsed.bestMs : null;
  } catch {
    return null;
  }
}

type ResultCard = {
  title: string;
  body: string;
  note: string;
  badge: string;
  air: string;
  resets: number;
  gates: string;
  jugs: number;
};

function cardFrom(sim: Sim, note: string): ResultCard {
  const score = scoreOf(sim);
  const cleared = !sim.dnf && sim.player.nextGate >= sim.track.gates.length;
  const prev = readBest();
  let badge = "Did not finish";
  if (cleared && (prev == null || score < prev)) badge = "New best";
  else if (cleared && prev != null) badge = `${((score - prev) / 1000).toFixed(2)}s off your best`;
  return {
    title: formatTime(score),
    body: cleared ? sim.track.name : `Stopped on ${sim.track.name}`,
    note,
    badge,
    air: `${sim.player.airTotal.toFixed(1)}s`,
    resets: sim.player.resets,
    gates: `${Math.min(sim.player.nextGate, sim.track.gates.length)}/${sim.track.gates.length}`,
    jugs: sim.player.jugs,
  };
}

async function settle(client: VibeCadeClient | null, sim: Sim): Promise<ResultCard> {
  const score = scoreOf(sim);
  const cleared = !sim.dnf && sim.player.nextGate >= sim.track.gates.length;
  const filed = cardFrom(sim, "Time kept on this truck.");
  const body = cleared
    ? `${sim.track.name} · ${sim.player.airTotal.toFixed(1)}s air · ${sim.player.resets} resets`
    : `DNF on ${sim.track.name}`;
  if (client && !client.isSpectator) {
    try {
      await client.submit({
        score,
        data: {
          stage: sim.track.name,
          seed: sim.track.seed,
          airMs: Math.round(sim.player.airTotal * 1000),
          resets: sim.player.resets,
          boosts: sim.player.boosts,
          finished: cleared,
        },
        display: { kind: "text", title: filed.title, body },
      });
      filed.note = "Time sent to VibeCade. Lower wins.";
    } catch {
      filed.note = "VibeCade did not take the time. It is still saved here.";
    }
    if (client.opponent?.isBot && sim.bot) {
      const botScore = sim.bot.finished ? Math.round(Math.max(1, sim.bot.finishTime) * 1000) : 210000;
      try {
        await client.submitFor(client.opponent.id, {
          score: botScore,
          display: { kind: "text", title: formatTime(botScore), body: "Pace truck" },
        });
      } catch {
        /* practice bot already filed */
      }
    }
    try {
      await client.stats.report({
        best_time: score,
        finishes: cleared ? 1 : 0,
        air_ms: Math.round(sim.player.airTotal * 1000),
      });
    } catch {
      /* stats appear once the listing is registered */
    }
    const ids: string[] = [];
    if (cleared) ids.push("finish");
    if (cleared && sim.player.resets === 0) ids.push("clean");
    if (sim.player.airTotal >= 4) ids.push("air");
    if (cleared && sim.player.finishTime > 0 && sim.player.finishTime < 70) ids.push("sub70");
    if (cleared && sim.bot?.finished && sim.player.finishTime < sim.bot.finishTime) ids.push("beatbot");
    if (sim.player.boosts >= 3) ids.push("boosts");
    for (const id of ids) {
      try {
        await client.achievements.unlock(id);
      } catch {
        /* host toast is optional */
      }
    }
    try {
      void client.ui.setStatus(filed.title);
    } catch {
      /* mock host still shows the result */
    }
  }
  if (cleared) {
    try {
      const prev = readBest();
      if (prev == null || score < prev) {
        localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 1, bestMs: score }));
      }
    } catch {
      /* private mode */
    }
  }
  return filed;
}

function HoldButton({
  code,
  label,
  inputRef,
  className,
  children,
}: {
  code: string;
  label: string;
  inputRef: RefObject<KeyInput | null>;
  className: string;
  children: ReactNode;
}) {
  const hold = (down: boolean) => {
    const keys = inputRef.current?.keys;
    if (!keys) return;
    if (down) keys.add(code);
    else keys.delete(code);
  };
  return (
    <button
      type="button"
      aria-label={label}
      className={className}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(true);
      }}
      onPointerUp={(e) => {
        hold(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={() => hold(false)}
    >
      {children}
    </button>
  );
}

const padBtn =
  "flex items-center justify-center rounded-2xl bg-surface font-display text-sm tracking-wide text-fg select-none";

export function MoonRace() {
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<KeyInput | null>(null);
  const armedRef = useRef(false);
  const unlockRef = useRef<() => void>(() => {});
  const timeRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const gateRef = useRef<HTMLSpanElement>(null);
  const boostRef = useRef<HTMLDivElement>(null);
  const calloutRef = useRef<HTMLParagraphElement>(null);
  const boostLabelRef = useRef<HTMLParagraphElement>(null);
  const jugRef = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<"boot" | "grid" | "race" | "done">("boot");
  const [stage, setStage] = useState("Seeding the regolith");
  const [you, setYou] = useState("You");
  const [rival, setRival] = useState("Pace truck");
  const [best, setBest] = useState<number | null>(null);
  const [fault, setFault] = useState("");
  const [result, setResult] = useState<ResultCard | null>(null);

  useEffect(() => {
    setBest(readBest());
    const host = hostRef.current;
    if (!host) return;
    const input = new KeyInput();
    inputRef.current = input;
    const audio = createAudio();
    unlockRef.current = () => audio.unlock();
    let dead = false;
    let world: World | null = null;
    let sim: Sim | null = null;
    let client: VibeCadeClient | null = null;
    let real = false;
    let matchGo = false;
    let racing = false;
    let submitted = false;
    let acc = 0;
    let poseT = 0;
    let ghost: GhostPose | null = null;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = new THREE.Timer();
    timer.connect(document);

    const onDown = (e: KeyboardEvent) => {
      input.keys.add(e.code);
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
      audio.unlock();
    };
    const onUp = (e: KeyboardEvent) => input.keys.delete(e.code);
    const onBlur = () => {
      input.keys.clear();
      input.mouseGas = false;
      input.mouseBrake = false;
    };
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    let mouseSteer = 0;
    let mouseHold = 0;
    let mouseOwns = false;
    let callout = "";
    let calloutT = 0;
    const onContext = (e: Event) => e.preventDefault();
    const onPointerDown = (e: PointerEvent) => {
      if (coarse || e.pointerType === "touch") return;
      if (e.target instanceof Element && e.target.closest("button")) return;
      if (e.button === 0) input.mouseGas = true;
      if (e.button === 2) input.mouseBrake = true;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 0) input.mouseGas = false;
      if (e.button === 2) input.mouseBrake = false;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (coarse || e.pointerType === "touch" || !racing) return;
      if (e.target instanceof Element && e.target.closest("button")) return;
      mouseSteer = Math.max(-1, Math.min(1, mouseSteer - e.movementX * 0.005));
      mouseHold = 0.45;
      mouseOwns = true;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("pointermove", onPointerMove);
    host.addEventListener("contextmenu", onContext);
    const onResize = () => world?.resize();
    window.addEventListener("resize", onResize);

    window.__controlsTest = {
      getYaw: () => sim?.player.yaw ?? 0,
      getSpeed: () => sim?.player.speed ?? 0,
      setKeys: (codes) => {
        input.keys.clear();
        input.mouseGas = false;
        input.mouseBrake = false;
        for (const code of codes) input.keys.add(code);
      },
      setSteer: (v) => {
        mouseOwns = false;
        input.steerOverride = v;
      },
    };

    let raf = 0;
    const frame = (stamp: number) => {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      timer.update(stamp);
      const dt = Math.min(0.05, timer.getDelta());
      if (world && sim) {
        const go = real ? matchGo : armedRef.current;
        if (mouseOwns) {
          mouseSteer *= Math.exp(-2.6 * dt);
          mouseHold -= dt;
          input.steerOverride = mouseSteer;
          if (mouseHold <= 0 && Math.abs(mouseSteer) < 0.04) {
            mouseSteer = 0;
            mouseOwns = false;
            input.steerOverride = null;
          }
        }
        if (go && !racing) {
          racing = true;
          callout = "GO";
          calloutT = 0.75;
          setPhase("race");
        }
        let gated = false;
        let boosted = false;
        let sipped = false;
        if (racing) {
          acc += dt;
          const step = 1 / 60;
          let guard = 0;
          while (acc >= step && guard < 5) {
            stepSim(sim, input, step, true);
            if (sim.player.justGate) gated = true;
            if (sim.player.justBoost) boosted = true;
            if (sim.player.justJug) sipped = true;
            acc -= step;
            guard += 1;
          }
        }
        if (gated) {
          callout = "GATE";
          calloutT = 0.7;
        }
        if (sipped) {
          callout = "WATER";
          calloutT = 0.7;
        }
        if (boosted) {
          callout = "BOOST";
          calloutT = 0.55;
        }
        updateWorld(world, sim, dt || 0.016, racing ? "chase" : "orbit", sim.bot ? null : ghost, reduce);
        audio.update(sim.player.speed, sim.player.boost);
        if (sim.player.impact > 3) audio.impact(sim.player.impact);
        if (sim.player.justBoost) audio.boost();
        if (sim.player.justGate) audio.gate();
        if (sim.player.justJug) audio.jug();

        if (timeRef.current) timeRef.current.textContent = formatTime(sim.time * 1000);
        if (speedRef.current) speedRef.current.textContent = String(Math.round(Math.abs(sim.player.speed) * 3.6));
        if (gateRef.current) {
          gateRef.current.textContent = `${Math.min(sim.player.nextGate, sim.track.gates.length)}/${sim.track.gates.length}`;
        }
        if (boostRef.current) {
          const fill = sim.player.boost > 0 ? 100 : Math.round(sim.player.charge * 100);
          boostRef.current.style.width = `${fill}%`;
        }
        if (jugRef.current) jugRef.current.textContent = String(sim.player.jugs);
        if (boostLabelRef.current) {
          boostLabelRef.current.textContent =
            sim.player.boost > 0 ? "Boosting" : sim.player.charge > 0.92 ? "Release to boost" : "Drift to charge";
        }
        if (calloutRef.current) {
          const wrong = sim.player.wrongWay >= 0.35;
          const off = racing && !querySurface(sim.track, sim.player.x, sim.player.z).onRoad;
          if (wrong) {
            calloutRef.current.hidden = false;
            calloutRef.current.textContent = "WRONG WAY";
          } else if (off && Math.abs(sim.player.speed) > 2) {
            calloutRef.current.hidden = false;
            calloutRef.current.textContent = "OFF TRACK";
          } else if (calloutT > 0) {
            calloutT -= dt;
            calloutRef.current.hidden = false;
            calloutRef.current.textContent = callout;
          } else {
            calloutRef.current.hidden = true;
          }
        }

        if (racing && client && !client.isSpectator) {
          poseT += dt;
          if (poseT > 0.125) {
            poseT = 0;
            const p = sim.player;
            try {
              void client.room.send("pose", { x: p.x, y: p.y, z: p.z, yaw: p.yaw, s: p.s, sp: p.speed }).catch(() => undefined);
            } catch {
              /* room budget */
            }
          }
        }

        if ((sim.player.finished || sim.dnf) && !submitted) {
          submitted = true;
          const doneSim = sim;
          const doneClient = client;
          setPhase("done");
          setResult(cardFrom(doneSim, "Sending the time…"));
          void settle(doneClient, doneSim).then((card) => {
            if (!dead) {
              setResult(card);
              setBest(readBest());
            }
          });
        }
      }
    };
    raf = requestAnimationFrame(frame);

    void (async () => {
      try {
        client = await openSession();
        if (dead) return;
        real = isRealHost(client);
        const track = buildTrack(client.match.seed, client.random.fork("stage"));
        const withBot = Boolean(client.opponent?.isBot) && !client.isSpectator;
        sim = createSim(track, withBot);
        world = createWorld(track, host);
        setStage(track.name);
        setYou(client.me.handle ? `@${client.me.handle}` : "You");
        setRival(client.opponent ? `@${client.opponent.handle}` : "Pace truck");
        if (!client.isSpectator) setPhase("grid");
        client.room.on("pose", (payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
          const o = payload as { x?: unknown; y?: unknown; z?: unknown; yaw?: unknown; s?: unknown };
          if (typeof o.x !== "number" || typeof o.y !== "number" || typeof o.z !== "number") return;
          ghost = {
            x: o.x,
            y: o.y,
            z: o.z,
            yaw: typeof o.yaw === "number" ? o.yaw : 0,
            s: typeof o.s === "number" ? o.s : 0,
          };
        });
        client.onStart(() => {
          matchGo = true;
        });
        if (client.isSpectator) {
          matchGo = true;
          setPhase("race");
        } else {
          void client.ready().catch(() => undefined);
        }
      } catch (err) {
        if (!dead) setFault(err instanceof Error ? err.message : "The stage failed to load.");
      }
    })();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      timer.disconnect();
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("contextmenu", onContext);
      window.removeEventListener("resize", onResize);
      world?.dispose();
      delete window.__controlsTest;
    };
  }, []);

  return (
    <main className="fixed inset-0 h-dvh touch-none select-none overflow-hidden bg-bg text-fg [-webkit-touch-callout:none]">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0 flex flex-col">
        <header className="flex items-start justify-between gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-4">
          <div className="min-w-0">
            <p className="font-display text-xs tracking-wide text-primary sm:text-sm">MOON RACE</p>
            <p className="truncate text-xs text-muted sm:text-sm">{stage}</p>
          </div>
          <div className={phase === "race" ? "shrink-0 text-right" : "hidden"}>
            <p className="text-xs tracking-wide text-muted uppercase">Time · lower wins</p>
            <p className="flex items-center justify-end gap-1.5 font-display text-2xl leading-none sm:gap-2 sm:text-3xl">
              <Timer className="size-4 text-primary sm:size-5" aria-hidden="true" />
              <span ref={timeRef}>0:00.00</span>
            </p>
            <p className="max-w-[46vw] truncate text-xs text-muted sm:max-w-none sm:text-sm">
              {you}
              <span className="text-ghost"> vs </span>
              {rival}
            </p>
          </div>
        </header>

        <div className="flex justify-center px-3">
          <p
            ref={calloutRef}
            hidden
            className="rounded-full bg-surface px-4 py-2 font-display text-sm tracking-wide text-primary"
          >
            GO
          </p>
        </div>

        <div className={`race-readout mt-auto items-end justify-between gap-3 px-3 sm:px-4 ${phase === "race" ? "flex" : "hidden"}`}>
          <div className="shrink-0">
            <p className="flex items-end gap-1.5 font-display text-4xl leading-none sm:gap-2 sm:text-5xl">
              <Gauge className="mb-0.5 size-5 text-primary sm:mb-1 sm:size-6" aria-hidden="true" />
              <span ref={speedRef}>0</span>
            </p>
            <p className="text-xs text-muted sm:text-sm">km/h</p>
          </div>
          <div className="mb-0.5 min-w-0 flex-1 sm:mb-1 sm:min-w-36">
            <p className="mb-1 flex items-center justify-between gap-2 text-xs text-muted sm:text-sm">
              <span className="inline-flex items-center gap-1">
                <Flag className="size-3.5 text-primary sm:size-4" aria-hidden="true" />
                Gates
                <span ref={gateRef}>0/0</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <Droplets className="size-3.5 text-ghost sm:size-4" aria-hidden="true" />
                <span ref={jugRef}>0</span>
              </span>
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-surface">
              <div ref={boostRef} className="h-full w-0 bg-primary" />
            </div>
            <p ref={boostLabelRef} className="mt-1 inline-flex items-center gap-1 text-xs text-muted sm:text-sm">
              <Zap className="size-3.5 text-primary sm:size-4" aria-hidden="true" />
              Drift to charge
            </p>
          </div>
        </div>
      </div>

      {phase !== "race" && phase !== "done" ? (
        <div className="absolute inset-0 flex items-end justify-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4">
          <section className="pointer-events-auto max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-4 sm:p-6">
            <p className="font-display text-xs tracking-wide text-primary sm:text-sm">LUNAR DIRT RALLY</p>
            <h1 className="mt-1 font-display text-4xl leading-none sm:text-5xl">MOON RACE</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Cross every gate in order. Blue jugs load into the bed. Lowest time wins.
            </p>
            <p className="mt-3 text-sm text-fg">{phase === "boot" ? "Building the stage…" : stage}</p>
            {best != null ? <p className="text-sm text-ghost">Your best {formatTime(best)}</p> : null}
            {fault ? <p className="mt-2 text-sm text-primary">{fault}</p> : null}
            <button
              type="button"
              className="mt-5 h-14 w-full rounded-xl bg-primary font-display text-lg text-bg"
              onClick={() => {
                unlockRef.current();
                armedRef.current = true;
              }}
            >
              Start
            </button>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <p className="font-display text-xs tracking-wide text-primary">Keyboard</p>
              <p className="font-display text-xs tracking-wide text-primary [@media(pointer:coarse)]:hidden">Mouse</p>
              <p className="hidden font-display text-xs tracking-wide text-primary [@media(pointer:coarse)]:block">Touch</p>
              <p className="text-muted">W gas · S brake</p>
              <p className="text-muted [@media(pointer:coarse)]:hidden">Move to steer. It coasts.</p>
              <p className="hidden text-muted [@media(pointer:coarse)]:block">Hold the bottom buttons.</p>
              <p className="text-muted">A left · D right</p>
              <p className="text-muted [@media(pointer:coarse)]:hidden">Left click gas</p>
              <p className="hidden text-muted [@media(pointer:coarse)]:block">Orange button is gas.</p>
              <p className="text-muted">Space drift · R reset</p>
              <p className="text-muted [@media(pointer:coarse)]:hidden">Right click brake</p>
              <p className="hidden text-muted [@media(pointer:coarse)]:block">Drift, then let go.</p>
            </div>
          </section>
        </div>
      ) : null}

      {phase === "done" && result ? (
        <div className="absolute inset-0 flex items-end justify-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4">
          <section className="pointer-events-auto max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1.5rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-4 text-center sm:p-6">
            <p className="font-display text-xs tracking-wide text-primary sm:text-sm">
              {result.badge === "Did not finish" ? "DNF" : "STAGE TIME"}
            </p>
            <p className="mt-2 font-display text-5xl leading-none sm:text-6xl">{result.title}</p>
            <p className="mt-2 text-sm text-primary">{result.badge}</p>
            <p className="mt-1 text-sm text-muted">{result.body}</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
              <div className="rounded-xl bg-bg px-2 py-2">
                <dt className="text-xs text-muted">Gates</dt>
                <dd className="font-display text-lg">{result.gates}</dd>
              </div>
              <div className="rounded-xl bg-bg px-2 py-2">
                <dt className="text-xs text-muted">Jugs</dt>
                <dd className="font-display text-lg">{result.jugs}</dd>
              </div>
              <div className="rounded-xl bg-bg px-2 py-2">
                <dt className="text-xs text-muted">Air</dt>
                <dd className="font-display text-lg">{result.air}</dd>
              </div>
              <div className="rounded-xl bg-bg px-2 py-2">
                <dt className="text-xs text-muted">Resets</dt>
                <dd className="font-display text-lg">{result.resets}</dd>
              </div>
            </dl>
            <p className="mt-3 text-sm text-fg">{result.note}</p>
            <button
              type="button"
              className="mt-5 inline-flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 font-display text-lg text-bg sm:w-auto"
              onClick={() => window.location.reload()}
            >
              <RotateCcw className="size-5" aria-hidden="true" />
              Run it back
            </button>
          </section>
        </div>
      ) : null}

      {phase === "race" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 hidden px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] [@media(pointer:coarse)]:block">
          <div className="pointer-events-auto flex items-end justify-between gap-2 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
            <div className="flex items-end gap-1.5">
              <HoldButton code="KeyA" label="Steer left" inputRef={inputRef} className={`${padBtn} h-16 w-16`}>
                Left
              </HoldButton>
              <HoldButton code="KeyD" label="Steer right" inputRef={inputRef} className={`${padBtn} h-16 w-16`}>
                Right
              </HoldButton>
            </div>
            <div className="flex items-end gap-1.5">
              <div className="flex flex-col gap-1.5">
                <HoldButton code="KeyR" label="Reset to last gate" inputRef={inputRef} className={`${padBtn} h-8 w-16 text-xs text-muted`}>
                  Reset
                </HoldButton>
                <HoldButton code="KeyS" label="Brake" inputRef={inputRef} className={`${padBtn} h-12 w-16`}>
                  Brake
                </HoldButton>
                <HoldButton code="Space" label="Drift" inputRef={inputRef} className={`${padBtn} h-12 w-16`}>
                  Drift
                </HoldButton>
              </div>
              <HoldButton
                code="KeyW"
                label="Gas"
                inputRef={inputRef}
                className="flex h-[7.25rem] w-[4.5rem] items-center justify-center rounded-2xl bg-primary font-display text-base tracking-wide text-bg select-none"
              >
                Gas
              </HoldButton>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
