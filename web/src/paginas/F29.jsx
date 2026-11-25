import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { MESES_LARGOS, TIPOS_DOC, hoy, peso } from '../util';
import { AYUDA_F29 } from '../ayudas';
import { Aviso, Dialogo, SelectorMes } from '../componentes';

const LINEAS = [
  ['538', 'Total débitos fiscales', true],
  ['537', 'Total créditos fiscales', true],
  ['504', 'Remanente crédito fiscal mes anterior', true],
  ['89', 'IVA determinado a pagar', true],
  ['77', 'Remanente crédito fiscal para el mes siguiente', true],
  ['563', 'Base imponible PPM (ingresos netos del mes)', true],
  ['115', 'Tasa PPM (%)', false],
  ['62', 'PPM neto determinado', true],
  ['48', 'Impuesto único de segunda categoría (remuneraciones)', true],
  ['151', 'Retención de honorarios', true],
  ['91', 'Total a pagar dentro del plazo', true],
];

export default function F29() {
  const { empresa, permite } = useEmpresa();
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [p, setP] = useState(null);
  const [guardadas, setGuardadas] = useState([]);
  const [msg, setMsg] = useState(null);
  const [marcar, setMarcar] = useState(null);
  const periodo = mes.replace('-', '');
  const nombrePeriodo = (per) => MESES_LARGOS[Number(String(per).slice(4, 6)) - 1] + ' ' + String(per).slice(0, 4);
  const tasa = (v) => Number(v ?? 0).toLocaleString('es-CL', { maximumFractionDigits: 3 }) + ' %';

  const cargar = useCallback(async () => {
    setP(await rpc('propuesta_f29', { p_empresa: empresa.id, p_periodo: periodo }));
    setGuardadas(await q(sb.from('f29_declaraciones').select('*').eq('empresa_id', empresa.id).order('periodo', { ascending: false }).limit(24)));
  }, [empresa.id, periodo]);
  useEffect(() => { setMsg(null); cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  async function confirmarPresentado(e) {
    e.preventDefault();
    try {
      await rpc('marcar_f29_presentado', { p_empresa: empresa.id, p_periodo: periodo, p_folio: marcar.folio || null });
      setMarcar(null);
      setMsg({ ok: true, t: 'F29 marcado como presentado. Su remanente pasa al mes siguiente y ya no se puede modificar.' });
      cargar();
    } catch (err) { setMarcar({ ...marcar, error: err.message }); }
  }

  async function guardar() {
    try { await rpc('guardar_f29', { p_empresa: empresa.id, p_periodo: periodo }); setMsg({ ok: true, t: 'Propuesta guardada. Cuando declares en sii.cl, márcala como presentada para fijarla y pasar su remanente al mes siguiente.' }); cargar(); }
    catch (e) { setMsg({ ok: false, t: e.message }); }
  }

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>{p ? (Number(p.lineas['91']) > 0 ? 'A pagar ' + peso(p.lineas['91']) : 'Sin pago; remanente ' + peso(p.lineas['77'])) : 'Propuesta F29'}</h1>
          <p className="chico">Formulario 29 · {nombrePeriodo(periodo)} · calculado desde los documentos aprobados del libro de compras y ventas</p>
        </div>
        <div className="filtros">
          <SelectorMes valor={mes} alCambiar={setMes} etiqueta="Período" />
          {permite('f29.guardar') && p?.guardada?.estado !== 'presentado' && <button className={p?.guardada && !p.guardada.cambio ? '' : 'primario'} onClick={guardar}>{p?.guardada ? 'Guardar de nuevo' : 'Guardar propuesta'}</button>}
          {permite('f29.guardar') && p?.guardada?.estado === 'borrador' && !p.guardada.cambio && <button className="primario" onClick={() => setMarcar({ folio: '' })}>Marcar como presentado</button>}
        </div>
      </header>
      <Aviso msg={msg} />
      {p && (
        <>
          {p.pendientes > 0 && <p className="aviso error" role="status">Hay {p.pendientes} documento{p.pendientes > 1 ? 's' : ''} del período por aprobar en Asientos: no se incluye{p.pendientes > 1 ? 'n' : ''} en esta propuesta hasta que el contador lo{p.pendientes > 1 ? 's' : ''} apruebe.</p>}
          {p.guardada?.estado === 'presentado' && <p className="aviso ok" role="status">Presentado en el SII{p.guardada.folio ? ' (folio ' + p.guardada.folio + ')' : ''}. Ya no se puede modificar.</p>}
          {p.guardada?.estado === 'borrador' && p.guardada.cambio && <p className="aviso error" role="status">La propuesta cambió desde que se guardó (total guardado {peso(p.guardada.totalPagar)}). Revísala y guárdala de nuevo.</p>}
          <div className="dos-columnas">
            <table className="tabla estado">
              <thead><tr><th data-ayuda="Número de la línea en el Formulario 29 del SII.">Código</th><th>Concepto</th><th className="n">Monto</th></tr></thead>
              <tbody>{LINEAS.map(([c, t, m]) => (
                <tr key={c} data-ayuda={AYUDA_F29[c]} className={['89', '91'].includes(c) ? 'total' + (c === '91' ? ' fuerte' : '') : ''}>
                  <td>{c}</td><td>{t}</td><td className="n">{m ? peso(p.lineas[c]) : tasa(p.lineas[c])}</td></tr>
              ))}</tbody>
            </table>
            <div>
              <Resumen t="Ventas del período" filas={p.ventas} />
              <Resumen t="Compras del período" filas={p.compras} />
            </div>
          </div>
          <p className="nota">{p.nota} Remanente del mes anterior tomado {p.remanenteDesde?.startsWith('presentado') ? 'del F29 presentado de ' + nombrePeriodo(p.remanenteDesde.slice(-6)) : p.remanenteDesde?.startsWith('borrador') ? 'de la propuesta guardada (no presentada) de ' + nombrePeriodo(p.remanenteDesde.slice(-6)) : 'del remanente inicial de la empresa'}.</p>
        </>
      )}
      <h2>Propuestas guardadas</h2>
      {guardadas.length === 0 ? <p className="vacio">Aún no hay propuestas guardadas.</p> : (
        <table className="tabla"><thead><tr><th>Período</th><th className="n">IVA determinado</th><th className="n">Remanente</th><th className="n">Total a pagar</th><th>Estado</th><th>Folio SII</th></tr></thead>
          <tbody>{guardadas.map((g) => (
            <tr key={g.id}><td>{nombrePeriodo(g.periodo)}</td><td className="n">{peso(g.iva_determinado)}</td><td className="n">{peso(g.remanente_siguiente)}</td><td className="n">{peso(g.total_pagar)}</td>
              <td><span className={'etiqueta ' + (g.estado === 'presentado' ? 'contabilizado' : 'borrador')}>{g.estado === 'presentado' ? 'Presentado' : 'Guardado'}</span></td><td>{g.folio_sii ?? ''}</td></tr>
          ))}</tbody></table>
      )}
      {marcar && (
        <Dialogo titulo="Marcar F29 como presentado" alCerrar={() => setMarcar(null)}>
          <form onSubmit={confirmarPresentado}>
            <h2>Marcar F29 de {nombrePeriodo(periodo)} como presentado</h2>
            <p>Úsalo cuando ya declaraste en sii.cl. El remanente de este mes pasará al siguiente y la propuesta quedará fija.</p>
            <label>Folio del F29 en el SII (opcional)<input value={marcar.folio} onChange={(e) => setMarcar({ ...marcar, folio: e.target.value })} maxLength={30} autoFocus /></label>
            {marcar.error && <p className="aviso error">{marcar.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setMarcar(null)}>Cancelar</button><button className="primario">Marcar como presentado</button></div>
          </form>
        </Dialogo>
      )}
    </section>
  );
}

function Resumen({ t, filas }) {
  return (
    <>
      <h2>{t}</h2>
      {filas.length === 0 ? <p className="vacio">Sin documentos.</p> : (
        <table className="tabla compacta"><thead><tr><th>Tipo</th><th className="n">Cant.</th><th className="n">Neto</th><th className="n">IVA</th><th className="n">Total</th></tr></thead>
          <tbody>{filas.map((f) => <tr key={f.tipo}><td>{f.tipo} {TIPOS_DOC[f.tipo]}</td><td className="n">{f.cantidad}</td><td className="n">{peso(f.neto)}</td><td className="n">{peso(f.iva)}</td><td className="n">{peso(f.total)}</td></tr>)}</tbody></table>
      )}
    </>
  );
}
