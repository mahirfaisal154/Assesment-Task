import Navbar from "./components/navbar";
import { Route, Routes, Navigate } from "react-router-dom";
import HomePage from "./pages/HomePage"
import JunctionPage from "./pages/JunctionPage";
import { useEffect } from "react";
import {Toaster} from "react-hot-toast"
import { useThemeStore } from "./store/useThemeStore.js";
import { useJunctionStore } from "./store/useJunctionStore.js";

const App = () => {
    const {theme} = useThemeStore();
    const {connectSocket, disconnectSocket} = useJunctionStore();

      useEffect(()=>{
        connectSocket();
        return ()=>disconnectSocket();
      }, [connectSocket, disconnectSocket]);
      useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
      }, [theme]);

  return (
    <div data-theme={theme}>
      <Toaster position="bottom-right"/>
      <Navbar/>
      <Routes>
        <Route path="/" element={<HomePage/>} />
        <Route path="/junctions/:id" element={<JunctionPage/>} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </div>
  )
};

export default App
