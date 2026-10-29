import { useEffect, useState } from "react"

export function formatTime(iso) {
  if(!iso) return "-"
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDuration(ms) {
  if(ms==null || Number.isNaN(ms)) return "-"
  const total=Math.max(0, Math.floor(ms/1000))
  const m=Math.floor(total/60)
  const s=total%60
  return m ? `${m}m ${s}s` : `${s}s`
}

// re-render every `interval` ms (for timers / countdowns)
export const useNow = (interval=1000) => {
  const [now, setNow] = useState(Date.now())
  useEffect(()=>{
    const id=setInterval(()=>setNow(Date.now()), interval)
    return ()=>clearInterval(id)
  },[interval])
  return now
}

// unique-ish ids for simulated sensor events
export const newEventId = (prefix="evt") => `${prefix}-${Date.now()}-${Math.floor(Math.random()*1000)}`

// monotonic sequence number for the simulated sensors
let lastSeq=0
export const nextSequenceNo = () => {
  lastSeq=Math.max(lastSeq+1, Math.floor(Date.now()/100))
  return lastSeq
}

export const SIGNAL_COLORS={
  GREEN:"bg-green-500",
  YELLOW:"bg-yellow-400",
  RED:"bg-red-500",
  UNKNOWN:"bg-gray-400",
}

export const modeBadgeClass = (mode) => ({
  AUTOMATIC:"badge-success",
  MANUAL:"badge-info",
  EMERGENCY:"badge-error",
  FAILURE:"badge-warning",
}[mode] || "badge-ghost")

export const statusBadgeClass = (status) => ({
  ONLINE:"badge-success",
  OFFLINE:"badge-error",
  DEGRADED:"badge-warning",
  WARNING:"badge-warning",
  UNKNOWN:"badge-ghost",
}[status] || "badge-ghost")
