import {create} from "zustand";

export const useThemeStore=create((set)=>({
  theme: localStorage.getItem("traffic-theme") || "light",
  setTheme:(theme)=>{
    localStorage.setItem("traffic-theme", theme);
    set({theme});
  },
}))
