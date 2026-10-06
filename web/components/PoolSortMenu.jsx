"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, SlidersHorizontal } from "lucide-react";
import { projectSortState, projectSortValue } from "../lib/project-directory.mjs";
import styles from "./PoolSortMenu.module.css";

export default function PoolSortMenu({ value, onChange, locale = "zh" }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  const id = useId();
  const en = locale === "en";
  const selected = projectSortState(value);
  const selectedValue = projectSortValue(selected.field, selected.direction);
  const options = [
    ["funded", en ? "Most shares funded" : "募集份额最多"],
    ["price", en ? "Lowest price per share" : "每份金额从低到高"],
    ["capacity", en ? "Lowest daily capacity price" : "日产能价从低到高"],
    ["id", en ? "Lowest miner ID" : "矿机编号从低到高"],
    ["funded-asc", en ? "Fewest shares funded" : "募集份额从少到多"],
    ["price-desc", en ? "Highest price per share" : "每份金额从高到低"],
    ["capacity-desc", en ? "Highest daily capacity price" : "日产能价从高到低"],
    ["id-desc", en ? "Highest miner ID" : "矿机编号从高到低"],
    ["total", en ? "Lowest total funding amount" : "总金额从低到高"],
    ["total-desc", en ? "Highest total funding amount" : "总金额从高到低"],
    ["hash", en ? "Lowest hash power" : "算力 H 从低到高"],
    ["hash-desc", en ? "Highest hash power" : "算力 H 从高到低"],
    ["daily", en ? "Lowest estimated daily BEM" : "预计日产 BEM 从低到高"],
    ["daily-desc", en ? "Highest estimated daily BEM" : "预计日产 BEM 从高到低"],
    ["members", en ? "Fewest participants" : "参与人数从少到多"],
    ["members-desc", en ? "Most participants" : "参与人数从多到少"],
  ];
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const selected = menu.current?.querySelector('[aria-checked="true"]');
    (selected || menu.current?.querySelector("button"))?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function onKeyDown(event) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    const buttons = [...menu.current.querySelectorAll("button")];
    let index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown") index = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") index = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buttons.length - 1;
    else return;
    event.preventDefault(); buttons[index].focus();
  }
  return <div ref={root} className={styles.root}>
    <button ref={trigger} className={`btn ${styles.trigger}`} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(previous => !previous)} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}><SlidersHorizontal size={16}/>{en ? "Sort & filter" : "筛选排序"}</button>
    {open && <div ref={menu} id={id} role="menu" aria-label={en ? "Sort pools" : "项目排序"} className={styles.menu} onKeyDown={onKeyDown}>
      {options.map(([key, label]) => <button key={key} type="button" role="menuitemradio" aria-checked={key === selectedValue}
        tabIndex={-1} onClick={() => { onChange(key); close(); }}>
        <span>{label}</span><Check size={16} aria-hidden="true" style={{ visibility: key === selectedValue ? "visible" : "hidden" }}/>
      </button>)}
    </div>}
  </div>;
}
