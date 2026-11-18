// 设置 › 学英语: one switch, and the details only once it is on.
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { t } from "../lib/i18n";
import { LEVELS, loadDict, useDict } from "../lib/dict";
import { useWords } from "../lib/words";
import { exportWords } from "./Learn";
import { ask } from "../lib/confirm";
import type { LearnLevel } from "../lib/settings";

const DAILY = [10, 20, 30];

export function LearnSettings() {
  const { s, save } = useStore(useShallow((st) => ({ s: st.settings, save: st.saveSettings })));
  const count = useWords((w) => Object.keys(w.words).length);
  const known = useWords((w) => Object.keys(w.known).length);
  const dictFailed = useDict((d) => d.failed);
  useEffect(() => { void useWords.getState().load(); if (s.learnOn) void loadDict(); }, [s.learnOn]);

  const exportAs = (kind: "anki" | "csv") => exportWords(kind, Object.values(useWords.getState().words).sort((x, y) => y.added - x.added));

  return (
    <div className="learn-settings">
      <section className="setup-block">
        <div className="ls-main">
          <div>
            <p className="ls-name">{t("英语学习模式")}</p>
            <p className="muted small">{t("点单词查释义，生词进生词本，按记忆曲线复习。只对英文节目生效。")}</p>
          </div>
          <button type="button" role="switch" aria-checked={s.learnOn} aria-label={t("英语学习模式")} className={`switch ${s.learnOn ? "on" : ""}`} onClick={() => void save({ learnOn: !s.learnOn, learnAsked: true })}><span /></button>
        </div>
        {s.learnOn && dictFailed && <p className="error-text small">{t("词典没能加载，查词暂时用不了。重启 SubCast 再试。")}</p>}
      </section>
      {s.learnOn && <>
        <section className="setup-block">
          <p className="setup-title">{t("水平")}</p>
          <div className="ls-group">
            <div className="ls-row">
              <span>{t("我的水平")}</span>
              <div className="seg-control" role="radiogroup" aria-label={t("我的水平")}>
                {LEVELS.map(([id, label]) => <button key={id} role="radio" aria-checked={s.learnLevel === id} className={s.learnLevel === id ? "on" : ""} onClick={() => void save({ learnLevel: id as LearnLevel })}>{t(label)}</button>)}
              </div>
            </div>
            <div className="ls-row"><label className="check"><input type="checkbox" checked={s.learnMark} onChange={(e) => void save({ learnMark: e.target.checked })} /> {t("在字幕里标出超过这个水平的词")}</label></div>
          </div>
        </section>
        <section className="setup-block">
          <p className="setup-title">{t("查词")}</p>
          <div className="ls-group">
            <div className="ls-row"><label className="check"><input type="checkbox" checked={s.learnCard} onChange={(e) => void save({ learnCard: e.target.checked })} /> {t("点单词弹出词卡")}</label></div>
            <div className="ls-row">
              <label className="check"><input type="checkbox" checked={s.learnAi} onChange={(e) => void save({ learnAi: e.target.checked })} /> {t("用 AI 解释「在这句里」的意思")}</label>
              <button className="link-btn small" onClick={() => useStore.getState().openSettings("ai")}>{t("用「AI」页的默认模型")}</button>
            </div>
          </div>
        </section>
        <section className="setup-block">
          <p className="setup-title">{t("生词本与复习")}</p>
          <div className="ls-group">
            <div className="ls-row"><label className="check"><input type="checkbox" checked={s.learnSide} onChange={(e) => void save({ learnSide: e.target.checked })} /> {t("侧栏显示「生词本」")}</label></div>
            <div className="ls-row">
              <span>{t("每天新学")}</span>
              <div className="seg-control" role="radiogroup" aria-label={t("每天新学")}>
                {DAILY.map((n) => <button key={n} role="radio" aria-checked={s.learnDaily === n} className={s.learnDaily === n ? "on" : ""} onClick={() => void save({ learnDaily: n })}>{n}</button>)}
              </div>
            </div>
            <div className="ls-row"><label className="check"><input type="checkbox" checked={s.learnSounds} onChange={(e) => void save({ learnSounds: e.target.checked })} /> {t("拼写复习时播放按键和对错音效")}</label></div>
            <div className="ls-row"><label className="check"><input type="checkbox" checked={s.learnRemind} onChange={(e) => void save({ learnRemind: e.target.checked })} /> {t("打开 SubCast 时，有要复习的词就提醒我")}</label></div>
            <div className="ls-row">
              <span>{t("生词本 {n} 个词", { n: count })}</span>
              <div className="row-actions">
                <button className="btn sm" disabled={!count} onClick={() => useStore.getState().go({ kind: "words" })}>{t("查看")}</button>
                <button className="btn sm" disabled={!count} onClick={() => void exportAs("anki")}>{t("导出 Anki")}</button>
                <button className="btn sm" disabled={!count} onClick={() => void exportAs("csv")}>{t("导出 CSV")}</button>
              </div>
            </div>
          </div>
          <div className="ls-group">
            <div className="ls-row">
              <span>{t("标为认识的词 {n} 个", { n: known })}<span className="muted small"> · {t("这些词不再标成生词")}</span></span>
              <button className="btn sm" disabled={!known} onClick={() => void ask({ title: t("清空标为认识的 {n} 个词？", { n: known }), message: t("清空后它们会按你的水平重新标出来。"), ok: t("清空"), danger: true }).then((yes) => { if (yes) useWords.getState().clearKnown(); })}>{t("清空")}</button>
            </div>
          </div>
          <p className="muted small">{t("词典来自开源的 ECDICT，离线可用。")}</p>
        </section>
      </>}
    </div>
  );
}
