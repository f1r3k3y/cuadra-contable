import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useEmpresa } from '../App';
import { rpc } from '../supabase';
import { MESES, ROLES, fecha, num, peso } from '../util';

const C = { ingreso: '#1f6f5c', gasto: '#c8371e', linea: '#171513', debito: '#c8371e', credito: '#1f6f5c' };
const miles = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + ' M' : Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + ' mil' : v);

export default function Panel() {
  const { empresa, permite, rol } = useEmpresa();
  const [t, setT] = useState(null);
  const finanzas = permite('reportes.ver');
  const [anio, setAnio] = useState(new Date().getFullYear());
  const [m, setM] = useState(null);
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    Promise.all([
      rpc('metricas_dashboard', { p_empresa: empresa.id, p_anio: anio }),
      rpc('metricas_documentos', { p_empresa: empresa.id, p_anio: anio }),
      permite('tesoreria.ver') ? rpc('resumen_tesoreria', { p_empresa: empresa.id }) : Promise.resolve(null),
    ]).then(([a, b, c]) => { setM(a); setD(b); setT(c); }).catch((e) => setError(e.message));
  }, [empresa.id, anio]);

  if (error) return <section className="hoja"><p className="aviso error">{error}</p></section>;
  if (!m || !d) return <section className="hoja"><p>Cargando indicadores…</p></section>;

  const k = m.kpis;
  const mensual = m.mensual.map((x) => ({ mes: MESES[x.mes - 1], Ingresos: Number(x.ingresos), Gastos: Number(x.costos) + Number(x.gastos), Resultado: Number(x.resultado) }));
  const iva = d.ivaMensual.map((x) => ({ mes: MESES[x.mes - 1], 'IVA débito': Number(x.debito), 'IVA crédito': Number(x.credito) }));
  const sinMovs = mensual.every((x) => !x.Ingresos && !x.Gastos);
  const pct = (v) => (v == null ? '—' : num(v) + ' %');
  const veces = (v) => (v == null ? '—' : String(v).replace('.', ','));

  const caja = t ? t.cuentas.reduce((x, c) => x + Number(c.saldo), 0) : k.caja;
  const pend = [];
  if (permite('asientos.contabilizar') && m.contabilidad.borradores > 0) pend.push(['/asientos', m.contabilidad.borradores, 'asientos y documentos por aprobar']);
  if (permite('asientos.crear') && !permite('asientos.contabilizar')) pend.push(['/asientos', m.contabilidad.borradores, 'registros esperando aprobación del contador']);
  if (permite('documentos.registrar')) pend.push(['/documentos', '+', 'registrar compras y ventas']);
  if (t && permite('tesoreria.ver')) {
    pend.push(['/tesoreria', peso(t.porCobrar.total), `por cobrar (${t.porCobrar.documentos} documentos)`]);
    pend.push(['/tesoreria', peso(t.porPagar.total), `por pagar (${t.porPagar.documentos} documentos)`]);
    const vencido = Number(t.porCobrar.vencido ?? 0);
    if (vencido > 0) pend.push(['/tesoreria', peso(vencido), 'por cobrar ya vencido']);
    const pagoVencido = Number(t.porPagar.vencido ?? 0);
    if (pagoVencido > 0) pend.push(['/tesoreria', peso(pagoVencido), 'por pagar ya vencido']);
  }
  if (permite('periodos.cerrar') && m.contabilidad.periodosAbiertos > 1) pend.push(['/empresa', m.contabilidad.periodosAbiertos, 'meses abiertos por cerrar']);
  if (permite('f29.ver')) pend.push(['/f29', 'F29', 'revisar la propuesta del mes']);
  if (permite('auditoria.ver')) pend.push(['/auditoria', '✓', 'revisar cambios y verificar la auditoría']);

  if (!finanzas) {
    return (
      <section className="hoja">
        <header className="cabecera"><div><h1>Caja y bancos {peso(caja)}</h1><p className="chico">{empresa.razon_social} · vista de {ROLES[rol]}</p></div></header>
        <div className="pendientes">{pend.map(([a, v, txt], i) => <Link key={i} to={a}><b>{v}</b><span>{txt}</span></Link>)}</div>
        {t && <>
          <h2>Saldos por cuenta</h2>
          <table className="tabla"><tbody>{t.cuentas.map((c) => <tr key={c.id}><td>{c.codigo} {c.nombre}</td><td className="n">{peso(c.saldo)}</td></tr>)}</tbody></table>
        </>}
        <div className="dos-columnas">
          <Ranking t="Principales clientes" filas={d.topClientes} />
          <Ranking t="Principales proveedores" filas={d.topProveedores} />
        </div>
      </section>
    );
  }

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>{k.resultado >= 0 ? 'Resultado ' + peso(k.resultado) : 'Pérdida ' + peso(-k.resultado)} en {anio}</h1>
          <p className="chico">{empresa.razon_social} · al {fecha(m.periodo.hasta)}</p>
        </div>
        <label className="en-linea">Año
          <select value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
            {[0, 1, 2, 3].map((i) => new Date().getFullYear() - i).map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
      </header>

      {pend.length > 0 && <div className="pendientes">{pend.map(([a, v, txt], i) => <Link key={i} to={a}><b>{v}</b><span>{txt}</span></Link>)}</div>}

      <div className="kpis">
        <Kpi t="Ventas netas" v={peso(k.ventas)} />
        <Kpi t="Margen bruto" v={pct(k.margenBruto)} />
        <Kpi t="Caja y bancos" v={peso(caja)} />
        <Kpi t="Liquidez corriente" v={veces(k.liquidezCorriente)} n="veces" />
        <Kpi t="Por cobrar" v={peso(k.cuentasPorCobrar)} n={k.diasCobro != null ? k.diasCobro + ' días de cobro' : null} />
        <Kpi t="Por pagar" v={peso(k.cuentasPorPagar)} n={k.diasPago != null ? k.diasPago + ' días de pago' : null} />
        <Kpi t="Endeudamiento" v={veces(k.endeudamiento)} n="pasivo / patrimonio" />
        <Kpi t="IVA del mes" v={peso(Number(m.ivaMesActual.debito) - Number(m.ivaMesActual.credito))} n="débito − crédito" />
      </div>

      {sinMovs ? (
        <p className="vacio">Aún no hay movimientos contabilizados en {anio}. Registra una compra o venta, o un asiento, para ver los gráficos.</p>
      ) : (
        <div className="graficos">
          <figure>
            <figcaption>Ingresos, gastos y resultado por mes</figcaption>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={mensual} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#00000014" vertical={false} />
                <XAxis dataKey="mes" tickLine={false} />
                <YAxis tickFormatter={miles} width={64} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v) => peso(v)} />
                <Legend />
                <Bar dataKey="Ingresos" fill={C.ingreso} radius={[2, 2, 0, 0]} />
                <Bar dataKey="Gastos" fill={C.gasto} radius={[2, 2, 0, 0]} />
                <Line dataKey="Resultado" stroke={C.linea} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </figure>
          <figure>
            <figcaption>IVA débito y crédito por mes</figcaption>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={iva} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#00000014" vertical={false} />
                <XAxis dataKey="mes" tickLine={false} />
                <YAxis tickFormatter={miles} width={64} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v) => peso(v)} />
                <Legend />
                <Bar dataKey="IVA débito" fill={C.debito} radius={[2, 2, 0, 0]} />
                <Bar dataKey="IVA crédito" fill={C.credito} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </figure>
        </div>
      )}

      <div className="dos-columnas">
        <Ranking t="Principales clientes" filas={d.topClientes} />
        <Ranking t="Principales proveedores" filas={d.topProveedores} />
        <div>
          <h2>Gastos por cuenta</h2>
          {m.gastosPorCuenta.length === 0 ? <p className="vacio">Sin gastos.</p> : (
            <ul className="barras">
              {m.gastosPorCuenta.map((g) => (
                <li key={g.cuenta}>
                  <span>{g.cuenta}</span><b>{peso(g.monto)}</b>
                  <i style={{ width: (g.monto / m.gastosPorCuenta[0].monto) * 100 + '%' }} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2>Estado contable</h2>
          <ul className="lista-simple">
            <li>Comprobantes contabilizados en {anio}: <b>{m.contabilidad.comprobantesAnio}</b></li>
            <li>Borradores pendientes: <b>{m.contabilidad.borradores}</b></li>
            <li>Períodos abiertos: <b>{m.contabilidad.periodosAbiertos}</b></li>
            <li>Capital de trabajo: <b>{peso(k.capitalTrabajo)}</b></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Kpi({ t, v, n }) {
  return <div className="kpi"><span>{t}</span><b>{v}</b>{n && <small>{n}</small>}</div>;
}

function Ranking({ t, filas }) {
  return (
    <div>
      <h2>{t}</h2>
      {filas.length === 0 ? <p className="vacio">Sin documentos este año.</p> : (
        <table className="tabla"><tbody>
          {filas.map((f) => <tr key={f.rut}><td>{f.nombre}</td><td className="n">{peso(f.monto)}</td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}
