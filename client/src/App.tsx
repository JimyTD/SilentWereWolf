import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import RoomPage from './pages/RoomPage';
import { useSocket } from './hooks/useSocket';
import { useConnectionStore } from './stores/connectionStore';

function GlobalErrorToast() {
  const globalError = useConnectionStore(s => s.globalError);
  const setGlobalError = useConnectionStore(s => s.setGlobalError);

  if (!globalError) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4">
      <div className="bg-red-500/90 text-white px-4 py-3 rounded-lg shadow-lg flex items-center justify-between">
        <span className="text-sm">{globalError}</span>
        <button
          onClick={() => setGlobalError(null)}
          className="ml-3 text-white/80 hover:text-white text-lg leading-none"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export default function App() {
  useSocket();

  return (
    <div className="min-h-screen bg-gray-900">
      <GlobalErrorToast />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </div>
  );
}
