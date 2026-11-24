import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { sb, q } from './supabase';
import { Login, DosPasos, NuevaClave } from './auth';
import { rutFormato, rutValido, ROLES } from './util';
import Panel from './paginas/Panel';
import Asientos from './paginas/Asientos';
import Documentos from './paginas/Documentos';
import Cuentas from './paginas/Cuentas';
import Reportes from './paginas/Reportes';
import F29 from './paginas/F29';
import Empresa from './paginas/Empresa';

const Ctx = createContext(null);
export const useEmpresa = () => useContext(Ctx);

const INACTIVIDAD_MIN = 20;

export default function App() {
  const [sesion, setSesion] = useState(undefined);
  const [aal, setAal] = useState(null);
  const [recuperando, setRecuperando] = useState(false);

  const revisarAal = useCallback(async () => {
    const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(error ? 'aal1' : data?.currentLevel ?? 'aal1');
  }, []);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSesion(data.session));
    const { data } = sb.auth.onAuthStateChange((evento, s) => {
      if (evento === 'PASSWORD_RECOVERY') setRecuperando(true);
      setSesion(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (sesion) revisarAal(); else setAal(null); }, [sesion, revisarAal]);

  // Cierre de sesión automático por inactividad
  useEffect(() => {
    if (!sesion) return;
    let t;
    const reiniciar = () => { clearTimeout(t); t = setTimeout(() => sb.auth.signOut(), INACTIVIDAD_MIN * 60000); };
    const ev = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    ev.forEach((e) => window.addEventListener(e, reiniciar, { passive: true }));
    reiniciar();
    return () => { clearTimeout(t); ev.forEach((e) => window.removeEventListener(e, reiniciar)); };
  }, [sesion]);

  if (sesion === undefined) return <div className="cargando">Cargando…</div>;
  if (!sesion) return <Login />;
  if (recuperando) return <NuevaClave alListo={() => setRecuperando(false)} />;
  if (aal === null) return <div className="cargando">Cargando…</div>;
  if (aal !== 'aal2') return <DosPasos alListo={revisarAal} />;
  return (
    <BrowserRouter>
      <Espacio usuario={sesion.user} />
    </BrowserRouter>
  );
}

function Espacio({ usuario }) {
  const [lista, setLista] = useState(null);
  const [actual, setActual] = useState(() => sessionStorage.getItem('empresa'));
  const [menu, setMenu] = useState(false);

  const cargar = useCallback(async () => {
    const filas = await q(sb.from('miembros').select('rol, empresas(id, rut, razon_social, tasa_ppm)').eq('user_id', usuario.id));
    setLista(filas.filter((f) => f.empresas).sort((a, b) => a.empresas.razon_social.localeCompare(b.empresas.razon_social)));
  }, [usuario.id]);
  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => { if (actual) sessionStorage.setItem('empresa', actual); }, [actual]);

  if (!lista) return <div className="cargando">Cargando empresas…</div>;
  const sel = lista.find((f) => f.empresas.id === actual) ?? lista[0];
  if (!sel) return <NuevaEmpresa usuario={usuario} alCrear={async (id) => { await cargar(); setActual(id); }} primera />;

  const ctx = {
    empresa: sel.empresas,
    rol: sel.rol,
    usuario,
    puede: (...roles) => roles.includes(sel.rol),
    recargarEmpresas: cargar,
    cambiar: setActual,
  };

  const nav = [
    ['/', 'Panel'],
    ['/documentos', 'Compras y ventas'],
    ['/asientos', 'Asientos'],
    ['/reportes', 'Libros y estados'],
    ['/f29', 'Propuesta F29'],
    ['/cuentas', 'Plan de cuentas'],
    ['/empresa', 'Empresa y usuarios'],
  ];

  return (
    <Ctx.Provider value={ctx}>
      <div className="marco">
        <aside className={menu ? 'lateral abierto' : 'lateral'}>
          <div className="marca"><span className="logo">C</span> Cuadra</div>
          <label className="selector">Empresa
            <select value={sel.empresas.id} onChange={(e) => (e.target.value === '+' ? setActual('+') : setActual(e.target.value))}>
              {lista.map((f) => <option key={f.empresas.id} value={f.empresas.id}>{f.empresas.razon_social}</option>)}
              <option value="+">+ Nueva empresa…</option>
            </select>
          </label>
          <nav onClick={() => setMenu(false)}>
            {nav.map(([a, t]) => <NavLink key={a} to={a} end={a === '/'}>{t}</NavLink>)}
          </nav>
          <div className="pie-lateral">
            <div>{usuario.email}</div>
            <div className="chico">{ROLES[sel.rol]} · {rutFormato(sel.empresas.rut)}</div>
            <button className="enlace" onClick={() => { sessionStorage.clear(); sb.auth.signOut(); }}>Cerrar sesión</button>
          </div>
        </aside>
        <main>
          <button className="boton-menu" onClick={() => setMenu(!menu)} aria-label="Menú">☰ Menú</button>
          {actual === '+' ? (
            <NuevaEmpresa usuario={usuario} alCrear={async (id) => { await cargar(); setActual(id); }} alCancelar={() => setActual(sel.empresas.id)} />
          ) : (
            <Routes key={sel.empresas.id}>
              <Route path="/" element={<Panel />} />
              <Route path="/documentos" element={<Documentos />} />
              <Route path="/asientos" element={<Asientos />} />
              <Route path="/reportes" element={<Reportes />} />
              <Route path="/f29" element={<F29 />} />
              <Route path="/cuentas" element={<Cuentas />} />
              <Route path="/empresa" element={<Empresa />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          )}
        </main>
      </div>
    </Ctx.Provider>
  );
}

function NuevaEmpresa({ usuario, alCrear, alCancelar, primera }) {
  const [f, setF] = useState({ rut: '', razon_social: '', giro: '', direccion: '', comuna: '', tasa_ppm: '0.25' });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function crear(e) {
    e.preventDefault();
    setError(null);
    if (!rutValido(f.rut)) return setError('El RUT no es válido.');
    try {
      const fila = await q(sb.from('empresas').insert({ ...f, tasa_ppm: Number(f.tasa_ppm), creado_por: usuario.id }).select('id').single());
      await alCrear(fila.id);
    } catch (err) { setError(err.message); }
  }

  return (
    <section className="hoja angosta">
      <h1>{primera ? 'Crea tu primera empresa' : 'Nueva empresa'}</h1>
      <p>Se crea con un plan de cuentas base chileno y tú quedas como administrador.</p>
      <form className="formulario" onSubmit={crear}>
        <label>RUT<input value={f.rut} onChange={set('rut')} onBlur={() => setF({ ...f, rut: rutFormato(f.rut) })} placeholder="76.123.456-7" required /></label>
        <label>Razón social<input value={f.razon_social} onChange={set('razon_social')} required maxLength={150} /></label>
        <label>Giro<input value={f.giro} onChange={set('giro')} required maxLength={150} /></label>
        <label>Dirección<input value={f.direccion} onChange={set('direccion')} maxLength={150} /></label>
        <label>Comuna<input value={f.comuna} onChange={set('comuna')} maxLength={60} /></label>
        <label>Tasa PPM (%)<input type="number" step="0.001" min="0" max="10" value={f.tasa_ppm} onChange={set('tasa_ppm')} /></label>
        {error && <p className="aviso error">{error}</p>}
        <div className="acciones">
          {alCancelar && <button type="button" onClick={alCancelar}>Cancelar</button>}
          <button className="primario">Crear empresa</button>
        </div>
      </form>
    </section>
  );
}
