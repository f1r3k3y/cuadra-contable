import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { csv, fecha, hoy, peso } from '../util';
import { Aviso, Dialogo } from '../componentes';
import { columnasCartola, leerArchivo, leerCsv, movimientosCartola } from '../importadores';

const CAMPOS = [['fecha', 'Fecha', true], ['descripcion', 'Descripción', true], ['referencia', 'N° documento', false],
  ['cargo', 'Cargo', false], ['abono', 'Abono', false], ['monto', 'Monto con signo', false], ['saldo', 'Saldo', false]];

export default function Conciliacion() {
  const { empresa, permite } = useEmpresa();
  const [bancos, setBancos] = useState([]);
  const [cuenta, setCuenta] = useState('');
  const [hasta, setHasta] = useState(hoy());
  const [res, setRes] = useState(null);
  const [vista, setVista] = useState('pendientes');
  const [hechos, setHechos] = useState([]);
  const [carga, setCarga] = useState(null);
  const [accion, setAccion] = useState(null);
  const [cuentasContra, setCuentasContra] = useState([]);
  const [msg, setMsg] = useState(null);
  const gestiona = permite('conciliacion.gestionar');

  useEffect(() => {
    q(sb.from('cuentas').select('id, codigo, nombre').eq('empresa_id', empresa.id).eq('es_efectivo', true).eq('imputable', true).eq('activa', true).order('codigo'))
      .then((cs) => { setBancos(cs); setCuenta((cs.find((c) => /banco/i.test(c.nombre)) ?? cs[0])?.id ?? ''); })
      .catch((e) => setMsg({ ok: false, t: e.message }));
    if (gestiona) q(sb.from('cuentas').select('id, codigo, nombre').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true).order('codigo'))
      .then(setCuentasContra).catch(() => {});
  }, [empresa.id, gestiona]);

  const cargar = useCallback(async () => {
    if (!cuenta) return;
    setRes(await rpc('resumen_conciliacion', { p_empresa: empresa.id, p_cuenta: cuenta, p_hasta: hasta }));
    if (vista === 'conciliados') {
      setHechos(await q(sb.from('cartola_movimientos').select('*').eq('empresa_id', empresa.id).eq('cuenta_id', cuenta)
        .neq('estado', 'pendiente').lte('fecha', hasta).order('fecha', { ascending: false }).limit(300)));
    }
  }, [empresa.id, cuenta, hasta, vista]);
  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  async function elegirArchivo(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) return setMsg({ ok: false, t: 'Use la cartola exportada como CSV (en Excel: Guardar como › CSV).' });
    if (file.size > 3_000_000) return setMsg({ ok: false, t: 'El archivo es demasiado grande (máximo 3 MB).' });
    try {
      const { cabecera, filas } = leerCsv(await leerArchivo(file));
      if (!cabecera.length || !filas.length) throw new Error('El archivo está vacío.');
      setCarga({ nombre: file.name, cabecera, filas, col: columnasCartola(cabecera) });
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  const [previa, setPrevia] = useState([]);
  useEffect(() => {
    if (!carga) return setPrevia([]);
    movimientosCartola(carga.filas, carga.col).then(setPrevia);
  }, [carga]);

  async function importar() {
    try {
      const r = await rpc('importar_cartola', { p_empresa: empresa.id, p_cuenta: cuenta, p_movimientos: previa });
      setCarga(null);
      setMsg({ ok: true, t: `Cartola cargada: ${r.nuevos} movimientos nuevos${r.repetidos ? `, ${r.repetidos} ya estaban` : ''}. ${r.conciliados} se conciliaron solos por monto y fecha.` });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function ejecutar(e) {
    e.preventDefault();
    try {
      if (accion.tipo === 'conciliar') await rpc('conciliar_movimiento', { p_movimiento: accion.mov.id, p_linea: accion.linea });
      if (accion.tipo === 'contabilizar') await rpc('contabilizar_movimiento', { p_movimiento: accion.mov.id, p_cuenta: accion.cuenta, p_glosa: accion.glosa });
      if (accion.tipo === 'ignorar') await rpc('ignorar_movimiento', { p_movimiento: accion.mov.id, p_nota: accion.nota });
      setAccion(null);
      setMsg({ ok: true, t: { conciliar: 'Movimiento conciliado.', contabilizar: 'Movimiento contabilizado y conciliado.', ignorar: 'Movimiento marcado como no contabilizable.' }[accion.tipo] });
      cargar();
    } catch (err) { setAccion({ ...accion, error: err.message }); }
  }

  async function auto() {
    try { const n = await rpc('conciliar_automatico', { p_empresa: empresa.id, p_cuenta: cuenta }); setMsg({ ok: true, t: `${n} movimientos conciliados por monto y fecha.` }); cargar(); }
    catch (err) { setMsg({ ok: false, t: err.message }); }
  }
  async function deshacer(m) {
    try { await rpc('desconciliar_movimiento', { p_movimiento: m.id }); setMsg({ ok: true, t: 'Conciliación deshecha; el movimiento vuelve a pendientes.' }); cargar(); }
    catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  if (!bancos.length) return <section className="hoja"><h1>Conciliación bancaria</h1><Aviso msg={msg} /><p>No hay cuentas de caja o banco en el plan de cuentas.</p></section>;
  const candidatas = (mov) => (res?.libroPendiente ?? []).filter((l) => Number(l.monto) === Number(mov.monto));
  const transitoLibro = (res?.libroPendiente ?? []).reduce((s, l) => s + Number(l.monto), 0);
  const transitoBanco = (res?.bancoPendiente ?? []).reduce((s, l) => s + Number(l.monto), 0);
  const ajustado = res?.saldoBanco != null ? Number(res.saldoBanco) + transitoLibro - transitoBanco : null;

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Conciliación bancaria</h1>
          <p className="chico">Cargue la cartola del banco: los movimientos que calzan en monto y fecha con la contabilidad se concilian solos; el resto se revisa aquí.</p>
        </div>
        <div className="filtros">
          <label>Cuenta<select value={cuenta} onChange={(e) => setCuenta(e.target.value)}>{bancos.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}</select></label>
          <label>Al<input type="date" value={hasta} max={hoy()} onChange={(e) => setHasta(e.target.value)} /></label>
          {gestiona && <label className="boton-archivo">Cargar cartola (CSV)<input type="file" accept=".csv,.txt,text/csv" onChange={elegirArchivo} hidden /></label>}
        </div>
      </header>
      <Aviso msg={msg} />

      {carga && (
        <div className="formulario">
          <h2>Revisar cartola: {carga.nombre}</h2>
          <p className="chico">Indique qué columna del archivo es cada dato (se propuso según los nombres). Use Cargo y Abono, o una sola columna de Monto con signo.</p>
          <div className="mapeo">
            {CAMPOS.map(([k, t, req]) => (
              <label key={k}>{t}{req ? '' : ' (opcional)'}
                <select value={carga.col[k]} onChange={(e) => setCarga({ ...carga, col: { ...carga.col, [k]: Number(e.target.value) } })}>
                  <option value={-1}>—</option>
                  {carga.cabecera.map((h, i) => <option key={i} value={i}>{h || `Columna ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          <p>{previa.length} movimientos leídos · abonos {peso(previa.filter((m) => m.monto > 0).reduce((s, m) => s + m.monto, 0))} · cargos {peso(-previa.filter((m) => m.monto < 0).reduce((s, m) => s + m.monto, 0))}</p>
          <div className="scroll"><table className="tabla">
            <thead><tr><th>Fecha</th><th>Descripción</th><th>N° doc.</th><th className="n">Monto</th><th className="n">Saldo</th></tr></thead>
            <tbody>{previa.slice(0, 8).map((m) => <tr key={m.huella}><td className="nw">{fecha(m.fecha)}</td><td>{m.descripcion}</td><td>{m.referencia}</td><td className="n">{peso(m.monto)}</td><td className="n">{m.saldo == null ? '' : peso(m.saldo)}</td></tr>)}</tbody>
          </table></div>
          {previa.length > 8 && <p className="chico">… y {previa.length - 8} más.</p>}
          <div className="acciones"><button onClick={() => setCarga(null)}>Cancelar</button><button className="primario" disabled={!previa.length} onClick={importar}>Cargar {previa.length} movimientos</button></div>
        </div>
      )}

      {res && (
        <>
          <div className="comparacion">
            <div><span>Saldo según banco{res.saldoBancoFecha ? ` (${fecha(res.saldoBancoFecha)})` : ''}</span><b>{res.saldoBanco == null ? '—' : peso(res.saldoBanco)}</b><small>{res.saldoBanco == null ? 'La cartola no trae saldo' : 'Último saldo de la cartola'}</small></div>
            <div><span>+ En contabilidad, aún no en el banco</span><b>{peso(transitoLibro)}</b><small>{res.libroPendiente.length} movimientos</small></div>
            <div><span>− En el banco, aún no en contabilidad</span><b>{peso(transitoBanco)}</b><small>{res.bancoPendiente.length} movimientos</small></div>
            <div className={ajustado != null && Math.abs(ajustado - Number(res.saldoLibro)) > 0 ? 'dif' : ''}><span>Saldo según contabilidad</span><b>{peso(res.saldoLibro)}</b>
              <small>{ajustado == null ? '' : Math.abs(ajustado - Number(res.saldoLibro)) > 0 ? `Diferencia sin explicar: ${peso(ajustado - Number(res.saldoLibro))}` : 'Cuadra con el banco ajustado'}</small></div>
          </div>

          <div className="pestanas">
            <button className={vista === 'pendientes' ? 'activa' : ''} onClick={() => setVista('pendientes')}>Pendientes</button>
            <button className={vista === 'conciliados' ? 'activa' : ''} onClick={() => setVista('conciliados')}>Conciliados ({res.conciliados}){res.ignorados ? ` · ignorados (${res.ignorados})` : ''}</button>
          </div>

          {vista === 'pendientes' ? (
            <div className="dos-columnas">
              <div>
                <h2>En el banco, sin contabilizar</h2>
                <table className="tabla">
                  <thead><tr><th>Fecha</th><th>Descripción</th><th className="n">Monto</th><th></th></tr></thead>
                  <tbody>
                    {res.bancoPendiente.length === 0 && <tr><td colSpan={4} className="vacio">Nada pendiente.</td></tr>}
                    {res.bancoPendiente.map((m) => (
                      <tr key={m.id}>
                        <td className="nw">{fecha(m.fecha)}</td><td>{m.descripcion}{m.referencia && <small> · {m.referencia}</small>}</td><td className="n">{peso(m.monto)}</td>
                        <td className="nw">{gestiona && <>
                          {candidatas(m).length > 0 && <button className="enlace" onClick={() => setAccion({ tipo: 'conciliar', mov: m, linea: candidatas(m)[0].lineaId })}>Conciliar</button>}{' '}
                          <button className="enlace" onClick={() => setAccion({ tipo: 'contabilizar', mov: m, cuenta: '', glosa: m.descripcion })}>Contabilizar</button>{' '}
                          <button className="enlace" onClick={() => setAccion({ tipo: 'ignorar', mov: m, nota: '' })}>Ignorar</button>
                        </>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h2>En contabilidad, sin aparecer en el banco</h2>
                <table className="tabla">
                  <thead><tr><th>Fecha</th><th>Asiento</th><th className="n">Monto</th></tr></thead>
                  <tbody>
                    {res.libroPendiente.length === 0 && <tr><td colSpan={3} className="vacio">Nada pendiente.</td></tr>}
                    {res.libroPendiente.map((l) => <tr key={l.lineaId}><td className="nw">{fecha(l.fecha)}</td><td>N° {l.numero} · {l.glosa}</td><td className="n">{peso(l.monto)}</td></tr>)}
                  </tbody>
                </table>
                <p className="chico">Suelen ser cheques girados aún no cobrados o depósitos en tránsito. Si un movimiento no calza, revise el monto o la fecha del asiento.</p>
              </div>
            </div>
          ) : (
            <table className="tabla">
              <thead><tr><th>Fecha</th><th>Descripción</th><th className="n">Monto</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {hechos.length === 0 && <tr><td colSpan={5} className="vacio">Aún no hay movimientos conciliados.</td></tr>}
                {hechos.map((m) => (
                  <tr key={m.id}><td className="nw">{fecha(m.fecha)}</td><td>{m.descripcion}{m.nota && <small> · {m.nota}</small>}</td><td className="n">{peso(m.monto)}</td>
                    <td><span className={'etiqueta ' + (m.estado === 'conciliado' ? 'contabilizado' : 'borrador')}>{m.estado === 'conciliado' ? 'Conciliado' : 'Ignorado'}</span></td>
                    <td>{gestiona && <button className="enlace" onClick={() => deshacer(m)}>Deshacer</button>}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="acciones izquierda">
            {gestiona && res.bancoPendiente.length > 0 && <button onClick={auto}>Conciliar automáticamente</button>}
            {res.bancoPendiente.length + res.libroPendiente.length > 0 && <button onClick={() => csv(`conciliacion_${hasta}`, [
              ...res.bancoPendiente.map((m) => ({ Partida: 'En banco, no en contabilidad', Fecha: fecha(m.fecha), Detalle: m.descripcion, Monto: m.monto })),
              ...res.libroPendiente.map((l) => ({ Partida: 'En contabilidad, no en banco', Fecha: fecha(l.fecha), Detalle: `N° ${l.numero} ${l.glosa}`, Monto: l.monto }))])}>Descargar partidas (CSV)</button>}
          </div>
        </>
      )}

      {accion && (
        <Dialogo titulo="Conciliar movimiento" alCerrar={() => setAccion(null)}>
          <form onSubmit={ejecutar}>
            <h2>{{ conciliar: 'Conciliar con la contabilidad', contabilizar: 'Contabilizar movimiento del banco', ignorar: 'No contabilizar' }[accion.tipo]}</h2>
            <p className="chico">{fecha(accion.mov.fecha)} · {accion.mov.descripcion} · {peso(accion.mov.monto)}</p>
            {accion.tipo === 'conciliar' && (
              <label>Movimiento contable del mismo monto<select value={accion.linea} onChange={(e) => setAccion({ ...accion, linea: e.target.value })}>
                {candidatas(accion.mov).map((l) => <option key={l.lineaId} value={l.lineaId}>{fecha(l.fecha)} · N° {l.numero} · {l.glosa}</option>)}
              </select></label>
            )}
            {accion.tipo === 'contabilizar' && <>
              <label>Cuenta de contrapartida<select value={accion.cuenta} onChange={(e) => setAccion({ ...accion, cuenta: e.target.value })} required>
                <option value="">Elegir cuenta…</option>
                {cuentasContra.filter((c) => c.id !== cuenta).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
              </select></label>
              <label>Glosa<input value={accion.glosa} onChange={(e) => setAccion({ ...accion, glosa: e.target.value })} maxLength={300} /></label>
              <p className="chico">Para comisiones e intereses del banco. Si es un cobro o pago de una factura, regístrelo en Tesorería y luego concílielo.</p>
            </>}
            {accion.tipo === 'ignorar' && <label>Motivo<input value={accion.nota} onChange={(e) => setAccion({ ...accion, nota: e.target.value })} minLength={5} required placeholder="Ej.: traspaso entre cuentas propias ya registrado" /></label>}
            {accion.error && <p className="aviso error">{accion.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAccion(null)}>Cancelar</button><button className="primario">Confirmar</button></div>
          </form>
        </Dialogo>
      )}
    </section>
  );
}
