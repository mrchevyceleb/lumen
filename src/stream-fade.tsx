import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import Markdown from "react-markdown";

// Words that arrive while an answer streams fade in instead of snapping into
// place. The feel is Operly's: each new word starts at zero opacity the moment
// it arrives and takes just under a second to settle, staggered by a few
// milliseconds so a whole network chunk still reads as printing, not as a
// block. Text already on screen is never replayed.

const FADE_MS = 875;
const MAX_STEP_MS = 18;
const motion = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const subscribeMotion = (listener: () => void) => {
  motion?.addEventListener("change", listener);
  return () => motion?.removeEventListener("change", listener);
};
const motionReduced = () => motion?.matches ?? false;
const noMotion = () => false;

function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, motionReduced, noMotion);
}

type Arrival = { from: number; to: number; at: number };
type Snapshot = { text: string; arrivals: Arrival[]; receivedAt: number };

function arrivalAt(arrivals: Arrival[], offset: number) {
  let low = 0;
  let high = arrivals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (arrivals[middle].to <= offset) low = middle + 1;
    else high = middle;
  }
  const arrival = arrivals[low];
  return arrival && offset >= arrival.from ? arrival.at : undefined;
}

// Compare against the previous render to find which words are new. Closing
// Markdown can rewrite an earlier fragment (an unclosed **bold**), so the
// unchanged suffix keeps its original age instead of flashing.
function snapshotFor(previous: Snapshot | null, text: string, settled: boolean, animate: boolean): Snapshot {
  const now = performance.now();
  let prefix = 0;
  if (previous) while (prefix < Math.min(text.length, previous.text.length) && text[prefix] === previous.text[prefix]) prefix++;
  let suffix = 0;
  if (previous) while (suffix < Math.min(text.length, previous.text.length) - prefix && text[text.length - suffix - 1] === previous.text[previous.text.length - suffix - 1]) suffix++;
  const words = [...text.matchAll(/\S+/gu)];
  const newWords = words.filter((word) => word.index! >= prefix && word.index! < text.length - suffix);
  // Start every batch immediately and fit its stagger into the gap since the
  // last one, so a slow stream still reads word by word.
  const interval = Math.min(120, Math.max(24, previous ? now - previous.receivedAt : 120));
  const step = Math.min(MAX_STEP_MS, interval / Math.max(1, newWords.length - 1));
  let next = 0;
  const arrivals: Arrival[] = [];
  for (const word of words) {
    const from = word.index!;
    const oldOffset = previous
      ? from < prefix
        ? from
        : from >= text.length - suffix
          ? from + previous.text.length - text.length
          : null
      : null;
    const at = oldOffset !== null
      ? arrivalAt(previous!.arrivals, oldOffset)
      : animate || !settled
        ? now + next++ * step
        : undefined;
    if (at !== undefined) arrivals.push({ from, to: from + word[0].length, at });
  }
  return { text, arrivals, receivedAt: now };
}

type FadeNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: FadeNode[] };

function rehypeStreamFade({ previous, draft, settled, animate }: { previous: Snapshot | null; draft: { current: Snapshot | null }; settled: boolean; animate: boolean }) {
  return (tree: FadeNode) => {
    // Measure what Markdown actually renders; source offsets drift around
    // escapes, entities and list prefixes. Text from separate blocks is joined
    // with a separator so appending a paragraph never reads as one long word;
    // the wrapping pass below counts the same separators.
    const values: string[] = [];
    let first = true;
    const collect = (node: FadeNode) => {
      if (node.type === "text") {
        if (!first) values.push("\n");
        first = false;
        values.push(node.value ?? "");
      } else node.children?.forEach(collect);
    };
    collect(tree);
    const text = values.join("");
    if (!draft.current) draft.current = snapshotFor(previous, text, settled, animate);
    const { arrivals } = draft.current;
    let offset = 0;
    let seenText = false;
    const visit = (node: FadeNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child): FadeNode[] => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const value = child.value ?? "";
        if (!seenText) seenText = true;
        else offset += 1;
        const start = offset;
        offset += value.length;
        if (!value.trim()) return [child];
        // Keep whitespace attached to its word so nothing reflows mid-fade.
        return [...value.matchAll(/\s+|\S+\s*/gu)].map((match) => {
          const at = arrivalAt(arrivals, start + match.index);
          return {
            type: "element",
            tagName: "span",
            properties: { className: ["stream-word"], ...(at !== undefined ? { "data-stream-at": at } : {}) },
            children: [{ type: "text", value: match[0] }],
          };
        });
      });
    };
    visit(tree);
  };
}

type MarkdownProps = ComponentProps<typeof Markdown>;

export function StreamingMarkdown({ text, animate, animationKey, rehypePlugins, ...rest }: {
  text: string;
  animate: boolean;
  animationKey: string;
  rehypePlugins?: MarkdownProps["rehypePlugins"];
} & Omit<MarkdownProps, "children" | "rehypePlugins">) {
  const reduced = useReducedMotion();
  // Once a message has streamed, keep its word wrappers for the rest of its
  // life: unwrapping them would repaint the finished reply.
  const [fade, setFade] = useState(animate);
  if (animate && !fade) setFade(true);
  const committed = useRef<Snapshot | null>(null);
  const rendered = useRef(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const wordAnimations = useRef(new WeakMap<HTMLElement, { at: number; animation?: Animation }>());
  const activeAnimations = useRef(new Set<Animation>());

  const draft = useMemo(() => ({ current: null as Snapshot | null }), [text, fade, reduced, animationKey]);

  useLayoutEffect(() => {
    const active = activeAnimations.current;
    return () => {
      active.forEach((animation) => animation.cancel());
      active.clear();
      wordAnimations.current = new WeakMap();
    };
  }, []);

  // One controller for every word in the reply. A word keeps its animation
  // when Markdown reuses or moves its node, so a re-parse does not replay it.
  useLayoutEffect(() => {
    const active = activeAnimations.current;
    if (reduced) {
      active.forEach((animation) => animation.cancel());
      active.clear();
      return;
    }
    wrapper.current?.querySelectorAll<HTMLElement>(".stream-word[data-stream-at]").forEach((element) => {
      const at = Number(element.dataset.streamAt);
      const prior = wordAnimations.current.get(element);
      if (prior?.at === at) return;
      prior?.animation?.cancel();
      const entry: { at: number; animation?: Animation } = { at };
      wordAnimations.current.set(element, entry);
      const elapsed = performance.now() - at;
      if (elapsed >= FADE_MS || !element.animate) return;
      const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "linear", fill: "backwards" });
      entry.animation = animation;
      active.add(animation);
      animation.onfinish = animation.oncancel = () => active.delete(animation);
      // Align the animation with when the word actually arrived, so a late
      // render does not make a whole batch fade in perfect lockstep.
      const timeline = document.timeline.currentTime;
      if (typeof timeline === "number") animation.startTime = timeline - elapsed;
      else animation.currentTime = elapsed;
    });
  }, [draft, reduced]);

  useLayoutEffect(() => {
    rendered.current = true;
    if (draft.current) committed.current = draft.current;
    // With reduced motion the plugin never runs, but the text on screen still
    // has to count as seen: turning the preference off mid-reply must fade
    // only the words that arrive after it, not the whole reply at once.
    else if (reduced) committed.current = { text, arrivals: [], receivedAt: performance.now() };
  }, [draft, reduced, text]);

  const plugins = useMemo<MarkdownProps["rehypePlugins"]>(
    () => fade && !reduced
      ? [...(rehypePlugins ?? []), [rehypeStreamFade, { previous: committed.current, draft, settled: rendered.current, animate }] as never]
      : rehypePlugins,
    [fade, reduced, rehypePlugins, draft, animate],
  );

  return (
    <div ref={wrapper} className="streaming-markdown">
      <Markdown {...rest} rehypePlugins={plugins}>{text}</Markdown>
    </div>
  );
}
