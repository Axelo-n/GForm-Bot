import { useId, useRef, useState, type KeyboardEvent } from "react";

type Option = { value: string; label: string };

export function Dropdown({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.findIndex(option => option.value === value);

  function show(fallback = 0) {
    const button = trigger.current;
    const popup = menu.current;
    if (!button || !popup || popup.matches(":popover-open")) return;
    const bounds = button.getBoundingClientRect();
    const width = Math.min(Math.max(bounds.width, 180), window.innerWidth - 16);
    const above = bounds.top - 12;
    const below = window.innerHeight - bounds.bottom - 12;
    const flip = below < 180 && above > below;
    Object.assign(popup.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`,
      top: flip ? "auto" : `${bounds.bottom + 4}px`,
      bottom: flip ? `${window.innerHeight - bounds.top + 4}px` : "auto",
      maxHeight: `${Math.min(260, Math.max(40, flip ? above : below))}px`,
    });
    popup.showPopover();
    popup.querySelectorAll("button")[selected < 0 ? fallback : selected]?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      menu.current?.hidePopover();
      trigger.current?.focus();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const target = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index + items.length - 1) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    items[target]?.focus();
  }

  return <div className="dropdown">
    <button className="dropdown-trigger" type="button" ref={trigger} disabled={!options.length}
      aria-label={`${label}: ${options[selected]?.label ?? "Belum ada pilihan"}`}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
      onClick={() => menu.current?.matches(":popover-open") ? menu.current.hidePopover() : show()}
      onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        show(event.key === "ArrowUp" ? options.length - 1 : 0);
      }}>
      <span>{options[selected]?.label ?? "Belum ada pilihan"}</span>
    </button>
    <div className="dropdown-menu" id={id} ref={menu} popover="auto" role="listbox" aria-label={label}
      onToggle={event => setOpen(event.newState === "open")} onKeyDown={navigate}>
      {options.map((option, index) => <button key={option.value} type="button" role="option" tabIndex={-1}
        aria-selected={selected === index} onClick={() => {
          menu.current?.hidePopover();
          trigger.current?.focus();
          onChange(option.value);
        }}>{option.label}</button>)}
    </div>
  </div>;
}
