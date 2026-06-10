"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: "◆" },
  { href: "/health", label: "Health", icon: "♡" },
  { href: "/calendar", label: "Calendar", icon: "▦" },
  { href: "/work", label: "Work", icon: "⊞" },
  { href: "/memory", label: "Memory", icon: "◎" },
  { href: "/profile", label: "Profile", icon: "◉" },
  { href: "/chat", label: "Chat", icon: "▷" },
  { href: "/finance", label: "Finance", icon: "$" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="sidebar__brand">Jarvis</div>
      {NAV_ITEMS.map((item) => {
        const active = item.href === "/"
          ? pathname === "/"
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar__item${active ? " sidebar__item--active" : ""}`}
          >
            <span className="sidebar__icon">{item.icon}</span>
            <span className="sidebar__label">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
