import { Fragment, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { csv, hoy, inicioAnio, peso } from '../util';

const VISTAS = [['diario', 'Libro diario'], ['mayor', 'Libro mayor'], ['b8', 'Balance 8 columnas'], ['bg', 'Balance general'], ['er', 'Estado de resultados']];

export default function Reportes() {
  const { empresa } = useEmpresa();
  const [vista, setVista] = useState('b8');
  const [desde, setDesde] = useState(inicioAnio());
  const [hasta, setHasta] = useState(hoy());
  const [cuenta, setCuenta] = useState('');
  const [cuentas, setCuentas] = useState([]);
  const [filas, setFilas] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    q(sb.from('cuentas').select('id, codigo, nombre').eq('empresa_id', empresa.id).eq('imputable', true).order('codigo')).then((c) => { setCuentas(c); setCuenta((x) => x || c[0]?.id || ''); });
  }, [empresa.id]);

  useEffect(() => {
    setFilas(null);
    setError(null);
    const p = { p_empresa: empresa.id };
    const llamada = {
      diario: () => rpc('libro_diario', { ...p, p_desde: desde, p_hasta: hasta }),
      mayor: () => (cuenta ? rpc('libro_mayor', { ...p, p_cuenta: cuenta, p_desde: desde, p_hasta: hasta }) : Promise.resolve([])),
      b8: () => rpc('balance_8_columnas', { ...p, p_desde: desde, p_hasta: hasta }),
      bg: () => rpc('balance_general', { ...p, p_hasta: hasta }),
      er: () => rpc('estado_resultados', { ...p, p_desde: desde, p_hasta: hasta }),
    }[vista];
    llamada().then(setFilas).catch((e) => setError(e.message));
  }, [empresa.id, vista, desde, hasta, cuenta]);

  const titulo = VISTAS.find((v) => v[0] === vista)[1];

  return (
    <section className="hoja">
      <header className="cabecera">
        <div><h1>{titulo}</h1><p className="chico">{empresa.razon_social} · {vista === 'bg' ? 'al ' + hasta : desde + ' a ' + hasta}</p></div>
        <div className="filtros">
          {vista !== 'bg' && <label className="en-linea">Desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>}
          <label className="en-linea">{vista === 'bg' ? 'Al' : 'Hasta'}<input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
          {vista === 'mayor' && <label className="en-linea">Cuenta<select value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
            {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}</select></label>}
        </div>
      </header>
      <div className="pestanas fila">
        {VISTAS.map(([k, t]) => <button key={k} className={vista === k ? 'activa' : ''} onClick={() => setVista(k)}>{t}</button>)}
      </div>
      {error && <p className="aviso error">{error}</p>}
      {!filas && !error && <p>Calculando…</p>}
      {filas && filas.length === 0 && <p className="vacio">Sin movimientos contabilizados en el rango.</p>}
      {filas && filas.length > 0 && (
        <>
          <div className="scroll">{{ diario: Diario, mayor: Mayor, b8: Balance8, bg: General, er: Resultados }[vista]({ filas })}</div>
          <button onClick={() => csv(titulo.toLowerCase().replace(/ /g, '_') + '_' + hasta, filas)}>Descargar CSV</button>
        </>
      )}
    </section>
  );
}

function Diario({ filas }) {
  let previo = null;
  return (
    <table className="tabla">
      <thead><tr><th className="n">N°</th><th>Fecha</th><th>Cuenta</th><th>Detalle</th><th className="n">Debe</th><th className="n">Haber</th></tr></thead>
      <tbody>{filas.map((f, i) => {
        const nuevo = f.asiento_id !== previo; previo = f.asiento_id;
        return (
          <tr key={i} className={nuevo ? 'separa' : ''}>
            <td className="n">{nuevo ? f.numero : ''}</td><td className="nw">{nuevo ? f.fecha : ''}</td>
            <td>{f.cuenta_codigo} {f.cuenta_nombre}</td><td>{nuevo ? f.glosa_asiento : f.glosa}{f.auxiliar_nombre && <small> · {f.auxiliar_nombre}</small>}</td>
            <td className="n">{Number(f.debe) ? peso(f.debe) : ''}</td><td className="n">{Number(f.haber) ? peso(f.haber) : ''}</td>
          </tr>
        );
      })}</tbody>
      <tfoot><tr><td colSpan={4}>Totales</td><td className="n">{peso(filas.reduce((s, f) => s + Number(f.debe), 0))}</td><td className="n">{peso(filas.reduce((s, f) => s + Number(f.haber), 0))}</td></tr></tfoot>
    </table>
  );
}

function Mayor({ filas }) {
  return (
    <table className="tabla">
      <thead><tr><th>Fecha</th><th className="n">N°</th><th>Glosa</th><th className="n">Debe</th><th className="n">Haber</th><th className="n">Saldo</th></tr></thead>
      <tbody>{filas.map((f, i) => (
        <tr key={i} className={i === 0 ? 'titulo-cuenta' : ''}><td className="nw">{f.fecha}</td><td className="n">{f.numero ?? ''}</td><td>{f.glosa}{f.auxiliar && <small> · {f.auxiliar}</small>}</td>
          <td className="n">{f.debe != null && Number(f.debe) ? peso(f.debe) : ''}</td><td className="n">{f.haber != null && Number(f.haber) ? peso(f.haber) : ''}</td><td className="n">{peso(f.saldo)}</td></tr>
      ))}</tbody>
    </table>
  );
}

function Balance8({ filas }) {
  const cols = ['debitos', 'creditos', 'deudor', 'acreedor', 'activo', 'pasivo', 'perdida', 'ganancia'];
  const t = Object.fromEntries(cols.map((c) => [c, filas.reduce((s, f) => s + Number(f[c]), 0)]));
  const resultado = t.ganancia - t.perdida;
  return (
    <table className="tabla compacta">
      <thead>
        <tr><th rowSpan={2}>Cuenta</th><th colSpan={2} className="c">Sumas</th><th colSpan={2} className="c">Saldos</th><th colSpan={2} className="c">Inventario</th><th colSpan={2} className="c">Resultados</th></tr>
        <tr>{['Débitos', 'Créditos', 'Deudor', 'Acreedor', 'Activo', 'Pasivo', 'Pérdida', 'Ganancia'].map((h) => <th key={h} className="n">{h}</th>)}</tr>
      </thead>
      <tbody>{filas.map((f) => (
        <tr key={f.codigo}><td>{f.codigo} {f.nombre}</td>{cols.map((c) => <td key={c} className="n">{Number(f[c]) ? peso(f[c]) : ''}</td>)}</tr>
      ))}</tbody>
      <tfoot>
        <tr><td>Subtotales</td>{cols.map((c) => <td key={c} className="n">{peso(t[c])}</td>)}</tr>
        <tr><td>{resultado >= 0 ? 'Utilidad del ejercicio' : 'Pérdida del ejercicio'}</td><td colSpan={4}></td>
          <td className="n">{resultado < 0 ? peso(-resultado) : ''}</td><td className="n">{resultado >= 0 ? peso(resultado) : ''}</td>
          <td className="n">{resultado >= 0 ? peso(resultado) : ''}</td><td className="n">{resultado < 0 ? peso(-resultado) : ''}</td></tr>
        <tr><td>Sumas iguales</td><td className="n">{peso(t.debitos)}</td><td className="n">{peso(t.creditos)}</td><td className="n">{peso(t.deudor)}</td><td className="n">{peso(t.acreedor)}</td>
          <td className="n">{peso(t.activo + Math.max(-resultado, 0))}</td><td className="n">{peso(t.pasivo + Math.max(resultado, 0))}</td>
          <td className="n">{peso(t.perdida + Math.max(resultado, 0))}</td><td className="n">{peso(t.ganancia + Math.max(-resultado, 0))}</td></tr>
      </tfoot>
    </table>
  );
}

function General({ filas }) {
  const secciones = ['Activo', 'Pasivo', 'Patrimonio'];
  const total = (s) => filas.filter((f) => f.seccion === s).reduce((a, f) => a + Number(f.saldo), 0);
  return (
    <table className="tabla estado">
      <tbody>
        {secciones.map((s) => (
          <Fragment key={s}>
            <tr className="titulo-cuenta"><td colSpan={2}>{s}</td></tr>
            {filas.filter((f) => f.seccion === s).map((f) => <tr key={s + f.codigo}><td>{f.codigo} {f.nombre}</td><td className="n">{peso(f.saldo)}</td></tr>)}
            <tr className="total"><td>Total {s.toLowerCase()}</td><td className="n">{peso(total(s))}</td></tr>
          </Fragment>
        ))}
        <tr className="total fuerte"><td>Total pasivo y patrimonio</td><td className="n">{peso(total('Pasivo') + total('Patrimonio'))}</td></tr>
      </tbody>
    </table>
  );
}

function Resultados({ filas }) {
  return (
    <table className="tabla estado">
      <tbody>{filas.map((f) => (
        <tr key={f.orden} className={f.es_total ? 'total' + (f.orden === 10 ? ' fuerte' : '') : ''}><td>{f.concepto}</td><td className="n">{peso(f.monto)}</td></tr>
      ))}</tbody>
    </table>
  );
}
