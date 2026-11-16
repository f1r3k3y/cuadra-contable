import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSesion } from '../lib/sesion';
import { supabase } from '../lib/supabase';
import { formatearRut } from '../../../supabase/functions/_shared/sii/rut.ts';

const MENU: { grupo: string; items: [string, string][] }[] = [
  { grupo: 'General', items: [['/', 'Panel de métricas']] },
  { grupo: 'Contabilidad', items: [['/asientos', 'Comprobantes'], ['/libros', 'Libros'], ['/estados', 'Estados financieros'], ['/plan', 'Plan de cuentas'], ['/auxiliares', 'Clientes y proveedores']] },
  { grupo: 'Tributario', items: [['/emitir', 'Emitir documento'], ['/emitidos', 'Documentos emitidos'], ['/recibidos', 'Documentos recibidos'], ['/rcv', 'Registro compras y ventas'], ['/f29', 'Formulario 29']] },
  { grupo: 'Administración', items: [['/configuracion', 'Configuración'], ['/auditoria', 'Auditoría']] },
];

export function Layout() {
  const { empresa, empresas, elegirEmpresa, session } = useSesion();
  const nav = useNavigate();
  return (
    <div className="app">
      <aside className="lateral">
        <div className="marca">
          <span className="marca-logo" aria-hidden />
          <span>Cuadra</span>
        </div>
        <div className="empresa-sel">
          <select
            value={empresa?.id ?? ''}
            onChange={(e) => (e.target.value === '__nueva' ? nav('/empresas') : elegirEmpresa(e.target.value))}
            aria-label="Empresa"
          >
            {empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre_fantasia || e.razon_social}
              </option>
            ))}
            <option value="__nueva">+ Agregar empresa…</option>
          </select>
          {empresa && (
            <div className="empresa-meta">
              <span className="mono">{formatearRut(empresa.rut)}</span>
              <span className={`ambiente amb-${empresa.sii_ambiente}`}>{empresa.sii_ambiente === 'produccion' ? 'SII producción' : 'SII certificación'}</span>
            </div>
          )}
        </div>
        <nav>
          {MENU.map((g) => (
            <div key={g.grupo} className="nav-grupo">
              <div className="nav-titulo">{g.grupo}</div>
              {g.items.map(([to, txt]) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'activo' : '')}>
                  {txt}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="usuario">
          <span title={session?.user.email}>{session?.user.email}</span>
          <span className="rol">{empresa?.rol}</span>
          <button className="btn btn-fantasma" onClick={() => supabase.auth.signOut()}>Salir</button>
        </div>
      </aside>
      <main className="contenido">
        <Outlet />
      </main>
    </div>
  );
}
