import { useEffect } from "react";
import { startJobListeners } from "./lib/jobs";
import { useStore } from "./store";
import { AddDialog, MiniPlayer, Sidebar, Toast } from "./components/Chrome";
import { DiscoverView, LatestView, RecentView, ShowView } from "./components/Lists";
import { EpisodeView } from "./components/EpisodeView";
import { AudioEngine } from "./components/Players";
import { SettingsDialog } from "./components/SettingsDialog";

export default function App() {
  const { ready, view, settingsOpen, addOpen, init } = useStore();

  useEffect(() => {
    startJobListeners();
    void init();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      const { player, time } = useStore.getState();
      if (e.code === "Space") { e.preventDefault(); player?.toggle(); }
      else if (e.code === "ArrowLeft") player?.seek(Math.max(0, time - 5));
      else if (e.code === "ArrowRight") player?.seek(time + 5);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="boot" />;
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
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
