import { Link } from "react-router-dom"
import { TrafficCone, Moon, Sun, Wifi, WifiOff } from "lucide-react"
import { useThemeStore } from "../store/useThemeStore"
import { useJunctionStore } from "../store/useJunctionStore"

const Navbar = () => {
  const {theme, setTheme} = useThemeStore()
  const {socketConnected, backendOnline} = useJunctionStore()

  return (
    <header className="bg-base-100 border-b border-base-300 fixed w-full top-0 z-40 backdrop-blur-lg bg-base-100/80">
      <div className="container mx-auto px-4 h-16">
        <div className="flex items-center justify-between h-full">
          <Link to="/" className="flex items-center gap-2.5 hover:opacity-80 transition-all">
            <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <TrafficCone className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-lg font-bold">Factory Traffic Control</h1>
          </Link>

          <div className="flex items-center gap-3">
            {/*live connection indicator*/}
            {!backendOnline ? (
              <span className="badge badge-error gap-1"><WifiOff className="size-3"/> Backend offline</span>
            ) : socketConnected ? (
              <span className="badge badge-success gap-1"><Wifi className="size-3"/> Live</span>
            ) : (
              <span className="badge badge-warning gap-1"><WifiOff className="size-3"/> Polling</span>
            )}
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setTheme(theme==="light" ? "dark" : "light")}
              title="Toggle theme"
            >
              {theme==="light" ? <Moon className="size-4"/> : <Sun className="size-4"/>}
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Navbar
