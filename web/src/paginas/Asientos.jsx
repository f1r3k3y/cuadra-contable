import { Fragment, useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { hoy, inicioMes, peso } from '../util';

const lineaVacia = () => ({ cuenta: '', debe: '', haber: '', glosa: '' });

export default function Asientos() {
  const { empresa, puede } = useEmpresa();
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [estado, setEstado] = useState('');
  const [lista, setLista] = useState([]);
  const [abierto, setAbierto] = useState(null);
  const [lineas, setLineas] = useState({});
  const [cuentas, setCuentas] = useState([]);
  const [nuevo, setNuevo] = useState(null);
  const [accion, setAccion] = useState(null);
  const [msg, setMsg] = useState(null);
  const escribe = puede('admin', 'contador', 'operador');
  const contabiliza = puede('admin', 'contador');

  const cargar = useCallback(async () => {
    let c = sb.from('asientos').select('*').eq('empresa_id', empresa.id).gte('fecha', desde).lte('fecha', hasta)
      .order('fecha', { ascending: false }).order('numero', { ascending: false }).limit(300);
    if (estado) c = c.eq('estado', estado);
    setLista(await q(c));
  }, [empresa.id, desde, hasta, estado]);

  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);
  useEffect(() => {
    q(sb.from('cuentas').select('id, codigo, nombre').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true).order('codigo')).then(setCuentas);
  }, [empresa.id]);

  async function ver(id) {
    if (abierto === id) return setAbierto(null);
    setAbierto(id);
    if (!lineas[id]) {
      const l = await q(sb.from('asiento_lineas').select('linea, debe, haber, glosa, cuentas(codigo, nombre), auxiliares(razon_social)').eq('asiento_id', id).order('linea'));
      setLineas((x) => ({ ...x, [id]: l }));
    }
  }

  const sumaD = nuevo ? nuevo.lineas.reduce((s, l) => s + Number(l.debe || 0), 0) : 0;
  const sumaH = nuevo ? nuevo.lineas.reduce((s, l) => s + Number(l.haber || 0), 0) : 0;
  const cuadra = sumaD > 0 && sumaD === sumaH;

  function cambiaLinea(i, k, v) {
    const ls = nuevo.lineas.map((l, j) => (j === i ? { ...l, [k]: v, ...(k === 'debe' && v ? { haber: '' } : {}), ...(k === 'haber' && v ? { debe: '' } : {}) } : l));
    setNuevo({ ...nuevo, lineas: ls });
  }

  async function guardar(contabilizar) {
    setMsg(null);
    const ls = nuevo.lineas.filter((l) => l.cuenta && (Number(l.debe) > 0 || Number(l.haber) > 0));
    if (ls.length < 2) return setMsg({ ok: false, t: 'El asiento necesita al menos dos líneas con cuenta y monto.' });
    try {
      await rpc('crear_asiento', {
        p_empresa: empresa.id, p_fecha: nuevo.fecha, p_glosa: nuevo.glosa, p_tipo: nuevo.tipo, p_contabilizar: contabilizar,
        p_lineas: ls.map((l) => ({ cuenta_id: l.cuenta, debe: Number(l.debe || 0), haber: Number(l.haber || 0), glosa: l.glosa })),
      });
      setNuevo(null);
      setMsg({ ok: true, t: contabilizar ? 'Asiento contabilizado.' : 'Asiento guardado como borrador.' });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function ejecutar(e) {
    e?.preventDefault();
    try {
      const a = accion;
      if (a.tipo === 'contabilizar') await rpc('contabilizar_asiento', { p_id: a.id });
      if (a.tipo === 'eliminar') await q(sb.from('asientos').delete().eq('id', a.id));
      if (a.tipo === 'anular') await rpc('anular_asiento', { p_id: a.id, p_motivo: a.motivo });
      if (a.tipo === 'reversar') await rpc('reversar_asiento', { p_id: a.id, p_fecha: a.fecha, p_motivo: a.motivo });
      setAccion(null);
      setLineas({});
      cargar();
    } catch (err) { setAccion({ ...accion, error: err.message }); }
  }

  return (
    <section className="hoja">
      <header className="cabecera">
        <div><h1>Asientos contables</h1><p className="chico">Un asiento contabilizado no se edita: se anula o se reversa, y todo queda en la auditoría.</p></div>
        <div className="filtros">
          <label className="en-linea">Desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
          <label className="en-linea">Hasta<input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
          <label className="en-linea">Estado<select value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todos</option><option value="borrador">Borrador</option><option value="contabilizado">Contabilizado</option><option value="anulado">Anulado</option>
          </select></label>
          {escribe && !nuevo && <button className="primario" onClick={() => setNuevo({ fecha: hoy(), glosa: '', tipo: 'traspaso', lineas: [lineaVacia(), lineaVacia()] })}>+ Nuevo asiento</button>}
        </div>
      </header>

      {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'}>{msg.t}</p>}

      {nuevo && (
        <div className="formulario">
          <div className="rejilla">
            <label>Fecha<input type="date" value={nuevo.fecha} onChange={(e) => setNuevo({ ...nuevo, fecha: e.target.value })} /></label>
            <label>Tipo<select value={nuevo.tipo} onChange={(e) => setNuevo({ ...nuevo, tipo: e.target.value })}>
              <option value="traspaso">Traspaso</option><option value="ingreso">Ingreso</option><option value="egreso">Egreso</option><option value="apertura">Apertura</option>
            </select></label>
            <label className="ancho">Glosa<input value={nuevo.glosa} onChange={(e) => setNuevo({ ...nuevo, glosa: e.target.value })} maxLength={500} required /></label>
          </div>
          <div className="scroll">
            <table className="tabla editable">
              <thead><tr><th>Cuenta</th><th className="n">Debe</th><th className="n">Haber</th><th>Detalle</th><th></th></tr></thead>
              <tbody>
                {nuevo.lineas.map((l, i) => (
                  <tr key={i}>
                    <td><select value={l.cuenta} onChange={(e) => cambiaLinea(i, 'cuenta', e.target.value)} aria-label="Cuenta">
                      <option value="">Elegir cuenta…</option>
                      {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
                    </select></td>
                    <td><input type="number" min="0" step="1" value={l.debe} onChange={(e) => cambiaLinea(i, 'debe', e.target.value)} aria-label="Debe" /></td>
                    <td><input type="number" min="0" step="1" value={l.haber} onChange={(e) => cambiaLinea(i, 'haber', e.target.value)} aria-label="Haber" /></td>
                    <td><input value={l.glosa} onChange={(e) => cambiaLinea(i, 'glosa', e.target.value)} maxLength={200} aria-label="Detalle" /></td>
                    <td>{nuevo.lineas.length > 2 && <button className="enlace" onClick={() => setNuevo({ ...nuevo, lineas: nuevo.lineas.filter((_, j) => j !== i) })}>Quitar</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td><button className="enlace" onClick={() => setNuevo({ ...nuevo, lineas: [...nuevo.lineas, lineaVacia()] })}>+ Agregar línea</button></td>
                <td className="n">{peso(sumaD)}</td><td className="n">{peso(sumaH)}</td>
                <td colSpan={2} className={cuadra ? 'ok-texto' : 'error-texto'}>{cuadra ? 'Cuadra' : 'Diferencia ' + peso(Math.abs(sumaD - sumaH))}</td></tr></tfoot>
            </table>
          </div>
          <div className="acciones">
            <button onClick={() => setNuevo(null)}>Cancelar</button>
            <button onClick={() => guardar(false)} disabled={!nuevo.glosa}>Guardar borrador</button>
            {contabiliza && <button className="primario" onClick={() => guardar(true)} disabled={!cuadra || !nuevo.glosa}>Contabilizar</button>}
          </div>
        </div>
      )}

      <div className="scroll">
        <table className="tabla">
          <thead><tr><th className="n">N°</th><th>Fecha</th><th>Tipo</th><th>Glosa</th><th className="n">Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {lista.length === 0 && <tr><td colSpan={7} className="vacio">No hay asientos en el rango.</td></tr>}
            {lista.map((a) => (
              <Fragment key={a.id}>
                <tr className={a.estado === 'anulado' ? 'anulado clic' : 'clic'} onClick={() => ver(a.id)}>
                  <td className="n">{a.numero ?? '—'}</td><td className="nw">{a.fecha}</td><td>{a.tipo}</td><td>{a.glosa}</td>
                  <td className="n">{peso(a.total_debe)}</td><td><span className={'etiqueta ' + a.estado}>{a.estado}</span></td>
                  <td className="nw" onClick={(e) => e.stopPropagation()}>
                    {a.estado === 'borrador' && contabiliza && <button className="enlace" onClick={() => setAccion({ tipo: 'contabilizar', id: a.id })}>Contabilizar</button>}
                    {a.estado === 'borrador' && escribe && <button className="enlace" onClick={() => setAccion({ tipo: 'eliminar', id: a.id })}>Eliminar</button>}
                    {a.estado === 'contabilizado' && contabiliza && a.origen === 'manual' && <>
                      <button className="enlace" onClick={() => setAccion({ tipo: 'anular', id: a.id, motivo: '', n: a.numero })}>Anular</button>
                      <button className="enlace" onClick={() => setAccion({ tipo: 'reversar', id: a.id, motivo: '', fecha: hoy(), n: a.numero })}>Reversar</button>
                    </>}
                  </td>
                </tr>
                {abierto === a.id && (
                  <tr className="detalle"><td colSpan={7}>
                    {!lineas[a.id] ? 'Cargando…' : (
                      <table className="tabla interna"><tbody>
                        {lineas[a.id].map((l) => (
                          <tr key={l.linea}><td>{l.cuentas.codigo} {l.cuentas.nombre}{l.auxiliares && <small> · {l.auxiliares.razon_social}</small>}{l.glosa && <small> · {l.glosa}</small>}</td>
                            <td className="n">{Number(l.debe) ? peso(l.debe) : ''}</td><td className="n">{Number(l.haber) ? peso(l.haber) : ''}</td></tr>
                        ))}
                      </tbody></table>
                    )}
                    {a.motivo_anulacion && <p className="chico">Motivo de anulación: {a.motivo_anulacion}</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {accion && (
        <div className="velo" role="dialog" aria-modal="true">
          <form className="dialogo" onSubmit={ejecutar}>
            <h2>{{ contabilizar: 'Contabilizar borrador', eliminar: 'Eliminar borrador', anular: `Anular asiento N° ${accion.n}`, reversar: `Reversar asiento N° ${accion.n}` }[accion.tipo]}</h2>
            {accion.tipo === 'contabilizar' && <p>Se le asignará número correlativo y ya no podrá editarse.</p>}
            {accion.tipo === 'eliminar' && <p>El borrador se elimina; la acción queda en la auditoría.</p>}
            {accion.tipo === 'reversar' && <label>Fecha del reverso<input type="date" value={accion.fecha} onChange={(e) => setAccion({ ...accion, fecha: e.target.value })} required /></label>}
            {['anular', 'reversar'].includes(accion.tipo) && <label>Motivo<input value={accion.motivo} onChange={(e) => setAccion({ ...accion, motivo: e.target.value })} minLength={5} required autoFocus /></label>}
            {accion.error && <p className="aviso error">{accion.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAccion(null)}>Cancelar</button>
              <button className={['eliminar', 'anular'].includes(accion.tipo) ? 'peligro' : 'primario'}>Confirmar</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
