import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import LandingPage       from './pages/LandingPage';
import RenewalRiskPage   from './pages/RenewalRiskPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/properties/:propertyId/renewal-risk" element={<RenewalRiskPage />} />
        {/* Redirect any unknown path back to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
