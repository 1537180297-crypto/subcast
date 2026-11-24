// Highlights and clip-making are for some people only: a setting shows or hides every way into them. Unset, they
// show for whoever has already exported a clip, and stay out of the way for everyone else.
import { useStore } from "../store";
import { useClipHistory } from "./clipHistory";

export function useClipTools(): boolean {
  const set = useStore((s) => s.settings.clipTools);
  const used = useClipHistory((s) => s.items.length > 0);
  return set ?? used;
}
