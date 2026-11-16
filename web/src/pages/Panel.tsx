import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, LineChart, Line, ReferenceLine } from 'recharts';
import { rpc } from '../lib/supabase';
import { useEmpresa } from '../lib/sesion';
import { pesos, pesosCortos, MESES, numero, NOMBRE_DTE } from '../lib/fmt';
import { Pagina, Tarjeta, Cargando, Aviso, Selector, useCarga } from '../components/ui';

interface Metricas {
  periodo: { desde: string; hasta: string };
  kpis: Record<string, number | null>;
  mensual: { mes: number; ingresos: number; costos: number; gastos: number; resultado: number; entradasCaja: number; salidasCaja: number }[];
  gastosPorCuenta: { cuenta: string; monto: number }[];
  topClientes: { rut: string; nombre: string; monto: number }[];
  topProveedores: { rut: string; nombre: string; monto: number }[];
  dte: { emitidosPorEstado: Record<string, number>; recibidosPendientes: number; plazoReclamoPorVencer: number; sinContabilizar: number };
  ivaMesActual: { debito: number; credito: number };
  contabilidad: { borradores: number; comprobantesAnio: number; periodosAbiertos: number };
}

const C1 = 'var(--series-1)';
const C2 = 'var(--series-2)';

function TooltipPesos({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="tooltip-t">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="tooltip-f">
          <span className="punto" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="mono">{pesos(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Kpi({ titulo, valor, detalle, tono }: { titulo: string; valor: string; detalle?: string; tono?: 'ok' | 'alerta' | 'error' }) {
  return (
    <div className="kpi">
      <div className="kpi-t">{titulo}</div>
      <div className={`kpi-v ${tono ? 'kpi-' + tono : ''}`}>{valor}</div>
      {detalle && <div className="kpi-d">{detalle}</div>}
    </div>
  );
}

const ratio = (v: number | null | undefined, suf = '') => (v === null || v === undefined ? '—' : numero(v) + suf);

export function Panel() {
  const empresa = useEmpresa();
  const anioActual = new Date().getFullYear();
  const [anio, setAnio] = useState(anioActual);
  const { datos: m, error, cargando } = useCarga<Metricas>(() => rpc('metricas_dashboard', { p_empresa: empresa.id, p_anio: anio }), [empresa.id, anio]);

  // Los meses que aún no ocurren no se dibujan (evita caídas falsas a cero).
  const mesActual = anio === anioActual ? new Date().getMonth() + 1 : 12;
  const serie = (m?.mensual ?? []).map((x) =>
    x.mes > mesActual
      ? { mes: x.mes, mesNombre: MESES[x.mes - 1], ingresos: null, egresos: null, resultado: null, entradasCaja: null, salidasCaja: null }
      : { ...x, mesNombre: MESES[x.mes - 1], egresos: x.costos + x.gastos },
  );
  const leyenda = (v: string) => <span style={{ color: 'var(--tinta-2)' }}>{v}</span>;
  const k = m?.kpis ?? {};
  const ivaNeto = (m?.ivaMesActual.debito ?? 0) - (m?.ivaMesActual.credito ?? 0);

  return (
    <Pagina
      titulo="Panel de métricas"
      sub={empresa.nombre_fantasia || empresa.razon_social}
      acciones={
        <Selector value={anio} onChange={(e) => setAnio(Number(e.target.value))} aria-label="Año">
          {[0, 1, 2, 3].map((d) => <option key={d} value={anioActual - d}>{anioActual - d}</option>)}
        </Selector>
      }
    >
      <Aviso tipo="error">{error}</Aviso>
      {cargando && !m ? <Cargando /> : m && (
        <>
          {(m.dte.plazoReclamoPorVencer > 0 || m.contabilidad.borradores > 0 || m.dte.sinContabilizar > 0) && (
            <div className="alertas">
              {m.dte.plazoReclamoPorVencer > 0 && <Link to="/recibidos" className="alerta-item alerta-error">! {m.dte.plazoReclamoPorVencer} documento(s) recibido(s) con plazo de reclamo por vencer (8 días)</Link>}
              {m.dte.recibidosPendientes > 0 && <Link to="/recibidos" className="alerta-item">{m.dte.recibidosPendientes} documento(s) recibido(s) por aceptar o reclamar</Link>}
              {m.dte.sinContabilizar > 0 && <Link to="/emitidos" className="alerta-item">{m.dte.sinContabilizar} documento(s) sin contabilizar</Link>}
              {m.contabilidad.borradores > 0 && <Link to="/asientos" className="alerta-item">{m.contabilidad.borradores} comprobante(s) en borrador</Link>}
            </div>
          )}

          <div className="kpis">
            <Kpi titulo="Ventas netas del año" valor={pesosCortos(Number(k.ventas ?? 0))} detalle={`al ${new Date(m.periodo.hasta + 'T12:00').toLocaleDateString('es-CL')}`} />
            <Kpi titulo="Resultado del año" valor={pesosCortos(Number(k.resultado ?? 0))} tono={Number(k.resultado) < 0 ? 'error' : undefined} detalle={`Margen operacional ${ratio(k.margenOperacional, '%')}`} />
            <Kpi titulo="Caja y bancos" valor={pesosCortos(Number(k.caja ?? 0))} detalle={`Capital de trabajo ${pesosCortos(Number(k.capitalTrabajo ?? 0))}`} />
            <Kpi titulo="IVA del mes (estimado)" valor={pesosCortos(Math.abs(ivaNeto))} detalle={ivaNeto >= 0 ? 'a pagar' : 'remanente a favor'} />
          </div>

          <div className="grid-3">
            <Tarjeta titulo="Ingresos y egresos por mes" className="span-2">
              <div className="grafico">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={serie} barGap={2} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    <XAxis dataKey="mesNombre" tickLine={false} axisLine={{ stroke: 'var(--eje)' }} tick={{ fill: 'var(--tinta-2)', fontSize: 12 }} />
                    <YAxis tickFormatter={pesosCortos} tickLine={false} axisLine={false} tick={{ fill: 'var(--tinta-2)', fontSize: 12 }} width={70} />
                    <Tooltip content={<TooltipPesos />} cursor={{ fill: 'var(--hover)' }} />
                    <Legend iconType="square" formatter={leyenda} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="ingresos" name="Ingresos" fill={C1} radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Bar dataKey="egresos" name="Costos y gastos" fill={C2} radius={[4, 4, 0, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Indicadores financieros">
              <dl className="ratios">
                <dt>Liquidez corriente</dt><dd>{ratio(k.liquidezCorriente)}</dd>
                <dt>Prueba ácida</dt><dd>{ratio(k.pruebaAcida)}</dd>
                <dt>Endeudamiento (pasivo / patrimonio)</dt><dd>{ratio(k.endeudamiento)}</dd>
                <dt>Margen bruto</dt><dd>{ratio(k.margenBruto, '%')}</dd>
                <dt>Margen operacional</dt><dd>{ratio(k.margenOperacional, '%')}</dd>
                <dt>Cuentas por cobrar</dt><dd>{pesos(k.cuentasPorCobrar)}</dd>
                <dt>Días promedio de cobro</dt><dd>{ratio(k.diasCobro)}</dd>
                <dt>Cuentas por pagar</dt><dd>{pesos(k.cuentasPorPagar)}</dd>
                <dt>Días promedio de pago</dt><dd>{ratio(k.diasPago)}</dd>
              </dl>
            </Tarjeta>
          </div>

          <div className="grid-3">
            <Tarjeta titulo="Resultado mensual">
              <div className="grafico">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={serie} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    <XAxis dataKey="mesNombre" tickLine={false} axisLine={{ stroke: 'var(--eje)' }} tick={{ fill: 'var(--tinta-2)', fontSize: 12 }} />
                    <YAxis tickFormatter={pesosCortos} tickLine={false} axisLine={false} tick={{ fill: 'var(--tinta-2)', fontSize: 12 }} width={70} />
                    <ReferenceLine y={0} stroke="var(--eje)" />
                    <Tooltip content={<TooltipPesos />} cursor={{ stroke: 'var(--eje)' }} />
                    <Line dataKey="resultado" name="Resultado" stroke={C1} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: 'var(--superficie)' }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Flujo de caja (entradas y salidas)">
              <div className="grafico">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={serie} barGap={2} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    <XAxis dataKey="mesNombre" tickLine={false} axisLine={{ stroke: 'var(--eje)' }} tick={{ fill: 'var(--tinta-2)', fontSize: 12 }} />
                    <YAxis tickFormatter={pesosCortos} tickLine={false} axisLine={false} tick={{ fill: 'var(--tinta-2)', fontSize: 12 }} width={70} />
                    <Tooltip content={<TooltipPesos />} cursor={{ fill: 'var(--hover)' }} />
                    <Legend iconType="square" formatter={leyenda} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="entradasCaja" name="Entradas" fill={C1} radius={[4, 4, 0, 0]} maxBarSize={14} />
                    <Bar dataKey="salidasCaja" name="Salidas" fill={C2} radius={[4, 4, 0, 0]} maxBarSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Principales gastos del año">
              {m.gastosPorCuenta.length ? (
                <ul className="barras-h">
                  {m.gastosPorCuenta.map((g) => (
                    <li key={g.cuenta} title={pesos(g.monto)}>
                      <div className="barras-h-et"><span>{g.cuenta}</span><span className="mono">{pesosCortos(g.monto)}</span></div>
                      <div className="barras-h-pista"><div style={{ width: `${(g.monto / m.gastosPorCuenta[0].monto) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              ) : <p className="sub">Sin gastos contabilizados.</p>}
            </Tarjeta>
          </div>

          <div className="grid-3">
            <Tarjeta titulo="Principales clientes">
              <TablaTop filas={m.topClientes} />
            </Tarjeta>
            <Tarjeta titulo="Principales proveedores">
              <TablaTop filas={m.topProveedores} />
            </Tarjeta>
            <Tarjeta titulo="Documentos tributarios del año">
              <dl className="ratios">
                {Object.entries(m.dte.emitidosPorEstado).map(([e, n]) => (
                  <Fragment key={e}><dt>Emitidos: {e.replace('_', ' ')}</dt><dd>{n}</dd></Fragment>
                ))}
                <dt>Recibidos por aceptar o reclamar</dt><dd>{m.dte.recibidosPendientes}</dd>
                <dt>Comprobantes contabilizados</dt><dd>{m.contabilidad.comprobantesAnio}</dd>
                <dt>Períodos abiertos</dt><dd>{m.contabilidad.periodosAbiertos}</dd>
              </dl>
              <p className="sub pequeno">Tipos: {Object.values(NOMBRE_DTE).slice(0, 4).join(', ')} y más.</p>
            </Tarjeta>
          </div>
        </>
      )}
    </Pagina>
  );
}

function TablaTop({ filas }: { filas: { rut: string; nombre: string; monto: number }[] }) {
  if (!filas.length) return <p className="sub">Sin documentos en el año.</p>;
  return (
    <table className="tabla compacta">
      <tbody>
        {filas.map((f) => (
          <tr key={f.rut}>
            <td>{f.nombre}<div className="sub mono pequeno">{f.rut}</div></td>
            <td className="num">{pesos(f.monto)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
