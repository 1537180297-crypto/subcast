import { useEffect } from "react";
import { startJobListeners } from "./lib/jobs";
import { useStore } from "./store";
import { AddDialog, MiniPlayer, Sidebar, Toast, TopBar } from "./components/Chrome";
import { DiscoverView, LatestView, RecentView, ShowView } from "./components/Lists";
import { EpisodeView } from "./components/EpisodeView";
import { AudioEngine, cycleMode, cycleRate } from "./components/Players";
import { useJobs } from "./lib/jobs";
import { activeIndex } from "./components/TranscriptPanel";
import { SettingsDialog } from "./components/SettingsDialog";

export default function App() {
  const { ready, view, settingsOpen, addOpen, init } = useStore();

  useEffect(() => {
    startJobListeners();
    void init();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { player, time, current } = useStore.getState();
      const segs = current ? useJobs.getState().transcripts[current.id]?.segments : undefined;
      if (e.code === "Space") { e.preventDefault(); player?.toggle(); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); player?.seek(Math.max(0, time - (e.shiftKey ? 5 : 15))); }
      else if (e.code === "ArrowRight") { e.preventDefault(); player?.seek(time + (e.shiftKey ? 5 : 30)); }
      else if ((e.code === "ArrowUp" || e.code === "ArrowDown") && segs?.length) {
        e.preventDefault();
        const i = activeIndex(segs, time);
        const j = Math.min(segs.length - 1, Math.max(0, e.code === "ArrowUp" ? (time - (segs[i]?.start ?? 0) > 2 ? i : i - 1) : i + 1));
        player?.seek(segs[j].start);
      }
      else if (e.code === "KeyC") cycleMode();
      else if (e.code === "KeyS") cycleRate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="boot" />;
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <TopBar />
        {view.kind === "latest" && <LatestView />}
        {view.kind === "recent" && <RecentView />}
        {view.kind === "discover" && <DiscoverView />}
        {view.kind === "show" && <ShowView key={view.id} id={view.id} />}
        {view.kind === "episode" && <EpisodeView key={view.id} id={view.id} />}
      </main>
      <MiniPlayer />
      <AudioEngine />
      {settingsOpen && <SettingsDialog />}
      {addOpen && <AddDialog />}
      <Toast />
    </div>
  );
}
