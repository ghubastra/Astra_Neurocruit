"use client";

import React from "react";
import Link from "next/link";
import { HiOutlineHome, HiOutlineUpload, HiOutlineUser, HiOutlineLogout } from "react-icons/hi";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: <HiOutlineHome size={22} /> },
  { name: "Upload Resume", href: "/upload", icon: <HiOutlineUpload size={22} /> },
  { name: "Profile", href: "/profile", icon: <HiOutlineUser size={22} /> },
  { name: "Logout", href: "/login", icon: <HiOutlineLogout size={22} /> },
];

export default function Sidebar({ current }: { current: string }) {
  return (
    <aside className="h-screen w-20 bg-[#212B36] border-r border-[#161C24] flex flex-col items-center py-6 shadow-xl">
      <div className="mb-12 flex flex-col items-center">
        <div className="w-11 h-11 rounded-2xl bg-[#2065D1] flex items-center justify-center mb-2 shadow-md">
          <span className="text-white text-2xl font-extrabold tracking-tight">J</span>
        </div>
        <span className="text-xs text-gray-400 font-semibold tracking-widest">JD</span>
      </div>
      <nav className="flex flex-col gap-6 flex-1 items-center w-full">
        {navItems.map((item) => (
          <Link
            key={item.name}
            href={item.href}
            className={`flex flex-col items-center gap-1 py-3 w-full rounded-xl transition-all duration-200 font-medium text-[13px] ${
              current === item.href
                ? "bg-[#2065D1] text-white shadow-lg"
                : "text-gray-400 hover:bg-[#1E293B] hover:text-white"
            }`}
            title={item.name}
          >
            {item.icon}
            <span className="text-[11px] font-semibold mt-1 hidden xl:block">{item.name}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
