import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles.css';
import { ProveedorSesion, useSesion } from './lib/sesion';
import { Layout } from './components/Layout';
import { Cargando } from './components/ui';
import { Acceso, VerificacionMfa } from './pages/Acceso';
import { NuevaEmpresa } from './pages/Empresas';
import { Panel } from './pages/Panel';
import { Asientos } from './pages/Asientos';
import { Libros } from './pages/Libros';
import { Estados } from './pages/Estados';
import { PlanCuentas, Auxiliares } from './pages/Maestros';
import { Emitir } from './pages/Emitir';
import { Emitidos } from './pages/Emitidos';
import { Recibidos } from './pages/Recibidos';
import { Rcv, F29 } from './pages/Tributario';
import { Configuracion } from './pages/Configuracion';
import { Auditoria } from './pages/Auditoria';

function App() {
  const { session, necesitaMfa, cargando, empresas, empresa, elegirEmpresa } = useSesion();
  useEffect(() => {
    if (!empresa && empresas.length) elegirEmpresa(empresas[0].id);
  }, [empresa, empresas, elegirEmpresa]);
  if (cargando) return <div className="centrado"><Cargando /></div>;
  if (!session) return <Acceso />;
  if (necesitaMfa) return <VerificacionMfa />;
  if (!empresas.length) return <NuevaEmpresa />;
  if (!empresa) return null;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Panel />} />
        <Route path="asientos" element={<Asientos />} />
        <Route path="libros" element={<Libros />} />
        <Route path="estados" element={<Estados />} />
        <Route path="plan" element={<PlanCuentas />} />
        <Route path="auxiliares" element={<Auxiliares />} />
        <Route path="emitir" element={<Emitir />} />
        <Route path="emitidos" element={<Emitidos />} />
        <Route path="recibidos" element={<Recibidos />} />
        <Route path="rcv" element={<Rcv />} />
        <Route path="f29" element={<F29 />} />
        <Route path="configuracion" element={<Configuracion key={empresa.id} />} />
        <Route path="auditoria" element={<Auditoria />} />
        <Route path="empresas" element={<NuevaEmpresa />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ProveedorSesion>
        <App />
      </ProveedorSesion>
    </BrowserRouter>
  </StrictMode>,
);
