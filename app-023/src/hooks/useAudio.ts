// 播放状态集中管理：AudioContext / 调度 / 循环 / 高亮位置 / 独奏静音
// UI 组件只负责显示与用户动作（保持状态逻辑集中在此 hook）
// 独奏/静音：作为 shouldPlay 谓词传给调度器，pump 时实时求值 ——
// 起播/循环/中段起播都按同一套选择过滤；播放中切换立即生效且不重建调度器。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleEvent, Score } from '../types';
import { barTicks, totalTicks } from '../lib/grid';
import { playRange, tickSeconds, type SchedulerHandle } from '../lib/audio';

export interface SoloMute {
  solo: Set<string>;
  muted: Set<string>;
}

export function useAudio(score: Score) {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const handleRef = useRef<SchedulerHandle | null>(null);
  const schedIdRef = useRef(0); // 调度句柄编号：每重建一次 +1（E2E 据此验证切换未打断播放）
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<{ bar: number; tick: number; insts: string[] } | null>(null);
  const [loop, setLoop] = useState<{ fromBar: number; toBar: number } | null>(null); // toBar 含
  const [soloMute, setSoloMute] = useState<SoloMute>({ solo: new Set(), muted: new Set() });
  const [debugEvents, setDebugEvents] = useState<ScheduleEvent[]>([]);
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const soloMuteRef = useRef(soloMute);
  soloMuteRef.current = soloMute;

  const ensureCtx = useCallback((): { ctx: AudioContext; master: GainNode } => {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterRef.current = master;
      (window as unknown as { __audioCtx?: AudioContext }).__audioCtx = ctx;
    }
    return { ctx: ctxRef.current, master: masterRef.current! };
  }, []);

  /** 该乐器当前是否应响：有独奏则仅独奏响，否则非静音都响（读 ref，任何时候都是最新选择） */
  const audibleInst = useCallback((id: string): boolean => {
    const { solo, muted } = soloMuteRef.current;
    if (solo.size > 0) return solo.has(id);
    return !muted.has(id);
  }, []);

  const audible = useCallback((ev: ScheduleEvent): boolean => audibleInst(ev.instrumentId), [audibleInst]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setPlaying(false);
    setPosition(null);
    setDebugEvents([]);
  }, []);

  const play = useCallback(
    (fromBar?: number) => {
      handleRef.current?.stop();
      const { ctx, master } = ensureCtx();
      // 等待上下文真正运行后再排程：suspended 时 currentTime 冻结，预排会挤在 0 附近
      ctx
        .resume()
        .catch(() => undefined)
        .then(() => {
          const s = scoreRef.current;
          const total = totalTicks(s.bars);
          let fromTick = 0;
          let toTick = total;
          if (loop) {
            fromTick = loop.fromBar > 0 ? s.bars.slice(0, loop.fromBar).reduce((a, b) => a + barTicks(b.beatsPerBar), 0) : 0;
            const toBarIdx = Math.min(loop.toBar + 1, s.bars.length);
            toTick = s.bars.slice(0, toBarIdx).reduce((a, b) => a + barTicks(b.beatsPerBar), 0);
          }
          if (fromBar != null && fromBar > 0) fromTick = s.bars.slice(0, fromBar).reduce((a, b) => a + barTicks(b.beatsPerBar), 0);
          if (toTick <= fromTick) return;

          const visual = (ev: ScheduleEvent) => {
            // 触发瞬间再查一次：排程后才被静音的击点不点亮
            if (!audible(ev)) return;
            // 同一格的多乐器齐奏合并点亮；进入新一格则替换
            setPosition((pos) =>
              pos && pos.bar === ev.barIndex && pos.tick === ev.offset
                ? { ...pos, insts: pos.insts.includes(ev.instrumentId) ? pos.insts : [...pos.insts, ev.instrumentId] }
                : { bar: ev.barIndex, tick: ev.offset, insts: [ev.instrumentId] },
            );
          };
          // shouldPlay 实时读 soloMuteRef：起播/循环/中段起播按当前选择过滤，播放中切换也即时生效
          const handle = playRange(ctx, master, s, fromTick, toTick, 1, visual, 0, audible);
          handleRef.current = handle;
          schedIdRef.current += 1;
          setPlaying(true);
          const durS = (toTick - fromTick) * tickSeconds(s.bpm) + 0.25;
          window.setTimeout(() => {
            if (handleRef.current === handle) {
              if (loop) {
                play();
              } else {
                stop();
              }
            }
          }, durS * 1000);
          // 调试钩子：E2E 用它断言调度精度
          (window as unknown as { __scheduled?: () => ScheduleEvent[] }).__scheduled = () => handle.scheduled();
          (window as unknown as { __schedId?: () => number }).__schedId = () => schedIdRef.current;
        });
    },
    [ensureCtx, loop, audible, stop],
  );

  const toggleSolo = useCallback((id: string) => {
    setSoloMute((sm) => {
      const solo = new Set(sm.solo);
      const muted = new Set(sm.muted);
      if (solo.has(id)) solo.delete(id);
      else {
        solo.add(id);
        muted.delete(id);
      }
      return { solo, muted };
    });
  }, []);

  const toggleMute = useCallback((id: string) => {
    setSoloMute((sm) => {
      const solo = new Set(sm.solo);
      const muted = new Set(sm.muted);
      if (muted.has(id)) muted.delete(id);
      else {
        muted.add(id);
        solo.delete(id);
      }
      return { solo, muted };
    });
  }, []);

  useEffect(() => () => handleRef.current?.stop(), []);

  // 独奏/静音变化立刻反映到高亮：把当前点亮中被禁的乐器马上摘掉，不等下一击。
  // 声音侧无需在此处理 —— 调度器 pump 时实时查 shouldPlay，天然即时生效且不打断。
  useEffect(() => {
    setPosition((pos) => {
      if (!pos) return pos;
      const insts = pos.insts.filter((id) => audibleInst(id));
      return insts.length === pos.insts.length ? pos : { ...pos, insts };
    });
  }, [soloMute, audibleInst]);

  return {
    playing,
    position,
    loop,
    setLoop,
    play,
    stop,
    soloMute,
    toggleSolo,
    toggleMute,
    debugEvents,
    ensureCtx,
  };
}
