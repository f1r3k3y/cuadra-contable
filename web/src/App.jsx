import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { sb, q, rpc } from './supabase';
import { Login, DosPasos, NuevaClave } from './auth';
import { rutFormato, rutValido, ROLES } from './util';
// Cada pantalla se descarga solo cuando se abre (los gráficos viajan con el Panel)
const Panel = lazy(() => import('./paginas/Panel'));
const Asientos = lazy(() => import('./paginas/Asientos'));
const Documentos = lazy(() => import('./paginas/Documentos'));
const Cuentas = lazy(() => import('./paginas/Cuentas'));
const Reportes = lazy(() => import('./paginas/Reportes'));
const F29 = lazy(() => import('./paginas/F29'));
const Empresa = lazy(() => import('./paginas/Empresa'));
const Tesoreria = lazy(() => import('./paginas/Tesoreria'));
const Auditoria = lazy(() => import('./paginas/Auditoria'));
const Honorarios = lazy(() => import('./paginas/Honorarios'));
const Remuneraciones = lazy(() => import('./paginas/Remuneraciones'));
const Conciliacion = lazy(() => import('./paginas/Conciliacion'));
const Sii = lazy(() => import('./paginas/Sii'));
const ActivoFijo = lazy(() => import('./paginas/ActivoFijo'));
const Cartera = lazy(() => import('./paginas/Cartera'));

// Enlace de invitación: https://…/#invitacion=TOKEN. Se guarda en la pestaña y se borra de la barra de direcciones.
{
  const m = window.location.hash.match(/invitacion=([\w-]{20,})/);
  if (m) { sessionStorage.setItem('invitacion', m[1]); window.history.replaceState(null, '', window.location.pathname); }
}

const Ctx = createContext(null);
export const useEmpresa = () => useContext(Ctx);

const INACTIVIDAD_MIN = 20;

// Cierra sesión dejando constancia en la auditoría
async function salir() {
  const emp = sessionStorage.getItem('empresa');
  if (emp && emp !== '+') { try { await rpc('registrar_acceso', { p_empresa: emp, p_evento: 'salida' }); } catch { /* sin conexión */ } }
  sessionStorage.clear();
  await sb.auth.signOut();
}

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
    const reiniciar = () => { clearTimeout(t); t = setTimeout(() => salir(), INACTIVIDAD_MIN * 60000); };
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
  const [errorRol, setErrorRol] = useState(null);
  const [permisos, setPermisos] = useState(null);
  const [aviso, setAviso] = useState(null);

  const cargar = useCallback(async () => {
    const token = sessionStorage.getItem('invitacion');
    if (token) {
      sessionStorage.removeItem('invitacion');
      try {
        const info = await rpc('ver_invitacion', { p_token: token });
        const id = await rpc('aceptar_invitacion', { p_token: token });
        sessionStorage.setItem('empresa', id);
        setActual(id);
        setAviso({ ok: true, t: `Te uniste a ${info?.empresa ?? 'la empresa'} como ${ROLES[info?.rol] ?? info?.rol}.` });
      } catch (e) { setAviso({ ok: false, t: 'No se pudo aceptar la invitación: ' + e.message }); }
    }
    const filas = await q(sb.from('miembros').select('rol, rol_prueba, rol_prueba_desde, empresas(id, rut, razon_social, tasa_ppm)').eq('user_id', usuario.id));
    // El modo "ver como" vence a las 8 horas (la base aplica la misma regla)
    const vigente = (f) => f.rol_prueba && f.rol_prueba_desde && Date.now() - new Date(f.rol_prueba_desde).getTime() < 8 * 3600e3;
    setLista(filas.filter((f) => f.empresas).map((f) => ({ ...f, rol_prueba: vigente(f) ? f.rol_prueba : null })).sort((a, b) => a.empresas.razon_social.localeCompare(b.empresas.razon_social)));
  }, [usuario.id]);
  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => { if (actual) sessionStorage.setItem('empresa', actual); }, [actual]);

  const sel0 = lista && (lista.find((f) => f.empresas.id === actual) ?? lista[0]);
  const claveRol = sel0 ? sel0.empresas.id + (sel0.rol_prueba ?? sel0.rol) : null;
  useEffect(() => {
    if (!sel0) return;
    setPermisos(null);
    rpc('mis_permisos', { p_empresa: sel0.empresas.id }).then((p) => setPermisos(new Set(p))).catch(() => setPermisos(new Set()));
    rpc('registrar_acceso', { p_empresa: sel0.empresas.id, p_evento: 'ingreso' }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveRol]);

  if (!lista) return <div className="cargando">Cargando empresas…</div>;
  const sel = lista.find((f) => f.empresas.id === actual) ?? lista[0];
  if (!sel) return <NuevaEmpresa usuario={usuario} alCrear={async (id) => { await cargar(); setActual(id); }} primera />;

  const rol = sel.rol_prueba ?? sel.rol;
  async function probar(nuevo) {
    setErrorRol(null);
    try { await rpc('probar_rol', { p_empresa: sel.empresas.id, p_rol: nuevo }); await cargar(); }
    catch (e) { setErrorRol(e.message); }
  }
  const ctx = {
    empresa: sel.empresas,
    rol,
    rolReal: sel.rol,
    usuario,
    permite: (p) => !!permisos?.has(p),
    recargarEmpresas: cargar,
    cambiar: setActual,
  };

  if (!permisos && actual !== '+') return <div className="cargando">Cargando permisos…</div>;

  const RUTAS = [
    ['/', 'Panel', 'panel.ver', <Panel />],
    ['/documentos', 'Compras y ventas', 'documentos.ver', <Documentos />],
    ['/honorarios', 'Honorarios', 'documentos.ver', <Honorarios />],
    ['/remuneraciones', 'Remuneraciones', 'remuneraciones.ver', <Remuneraciones />],
    ['/tesoreria', 'Tesorería', 'tesoreria.ver', <Tesoreria />],
    ['/conciliacion', 'Conciliación bancaria', 'conciliacion.ver', <Conciliacion />],
    ['/activos', 'Activo fijo', 'activos.ver', <ActivoFijo />],
    ['/asientos', 'Asientos', 'asientos.ver', <Asientos />],
    ['/reportes', 'Libros y estados', 'reportes.ver', <Reportes />],
    ['/f29', 'Propuesta F29', 'f29.ver', <F29 />],
    ['/sii', 'SII y RCV', 'rcv.ver', <Sii />],
    ['/cuentas', 'Plan de cuentas', 'cuentas.ver', <Cuentas />],
    ['/auditoria', 'Auditoría', 'auditoria.ver', <Auditoria />],
    ...(lista.length > 1 ? [['/cartera', 'Mis empresas', null, <Cartera />]] : []),
    ['/empresa', 'Empresa y roles', null, <Empresa />],
  ];
  const visibles = RUTAS.filter(([, , p]) => !p || ctx.permite(p));

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
          {sel.rol === 'admin' && (
            <label className="selector">Ver la app como
              <select value={rol} onChange={(e) => probar(e.target.value)}>
                {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}{k === 'admin' ? ' (tu rol real)' : ''}</option>)}
              </select>
            </label>
          )}
          <nav onClick={() => setMenu(false)}>
            {visibles.map(([a, t]) => <NavLink key={a} to={a} end={a === '/'}>{t}</NavLink>)}
          </nav>
          <div className="pie-lateral">
            <div>{usuario.email}</div>
            <div className="chico">{ROLES[rol]}{sel.rol_prueba ? ' (prueba)' : ''} · {rutFormato(sel.empresas.rut)}</div>
            <button className="enlace" onClick={() => salir()}>Cerrar sesión</button>
          </div>
        </aside>
        <main>
          <button className="boton-menu" onClick={() => setMenu(!menu)} aria-label="Menú">☰ Menú</button>
          {errorRol && <p className="aviso error">{errorRol}</p>}
          {aviso && <p className={aviso.ok ? 'aviso ok' : 'aviso error'} role={aviso.ok ? 'status' : 'alert'}>{aviso.t} <button className="enlace" onClick={() => setAviso(null)}>Cerrar</button></p>}
          {sel.rol_prueba && (
            <div className="franja-prueba" role="status">
              <span>Estás viendo la app como <b>{ROLES[sel.rol_prueba]}</b>. La base de datos aplica los permisos reales de ese rol.</span>
              <button onClick={() => probar('admin')}>Volver a Administrador</button>
            </div>
          )}
          {actual === '+' ? (
            <NuevaEmpresa usuario={usuario} alCrear={async (id) => { await cargar(); setActual(id); }} alCancelar={() => setActual(sel.empresas.id)} />
          ) : (
            <Suspense fallback={<section className="hoja"><p className="cargando-pagina">Cargando…</p></section>}>
              <Routes key={sel.empresas.id + rol}>
                {visibles.map(([a, , , el]) => <Route key={a} path={a} element={el} />)}
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </Suspense>
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
