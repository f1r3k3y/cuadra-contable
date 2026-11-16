import { useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { cuentas, auxiliares, centrosCosto } from '../lib/maestros';
import { pesos, fecha, hoy, inicioAnio, csv } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Estado, Aviso, Modal, Vacio, Cargando, useCarga } from '../components/ui';

interface Linea { cuenta_id: string; debe: string; haber: string; glosa: string; auxiliar_id: string; centro_costo_id: string }
const lineaVacia = (): Linea => ({ cuenta_id: '', debe: '', haber: '', glosa: '', auxiliar_id: '', centro_costo_id: '' });

export function Asientos() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const [desde, setDesde] = useState(inicioAnio());
  const [hasta, setHasta] = useState(hoy());
  const [estado, setEstado] = useState('');
  const [buscar, setBuscar] = useState('');
  const [editor, setEditor] = useState(false);
  const [detalle, setDetalle] = useState<any | null>(null);
  const [error, setError] = useState('');

  const { datos, cargando, recargar } = useCarga(async () => {
    let q = supabase.from('asientos').select('*, asiento_lineas(*, cuentas(codigo, nombre), auxiliares(rut, razon_social))')
      .eq('empresa_id', empresa.id).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false }).order('numero', { ascending: false }).limit(500);
    if (estado) q = q.eq('estado', estado);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  }, [empresa.id, desde, hasta, estado]);

  const filtrados = (datos ?? []).filter((a: any) => !buscar || `${a.numero} ${a.glosa}`.toLowerCase().includes(buscar.toLowerCase()));

  async function accion(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      setDetalle(null);
      recargar();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Pagina
      titulo="Comprobantes contables"
      sub="Ingresos, egresos y traspasos. Un comprobante contabilizado no se edita: se anula o se reversa."
      acciones={<>
        <Boton variante="secundario" onClick={() => csv('comprobantes.csv', filtrados.flatMap((a: any) => a.asiento_lineas.map((l: any) => ({ numero: a.numero, fecha: a.fecha, tipo: a.tipo, glosa: a.glosa, estado: a.estado, cuenta: l.cuentas.codigo, nombre: l.cuentas.nombre, debe: l.debe, haber: l.haber }))))}>Exportar CSV</Boton>
        {puede('admin', 'contador', 'operador') && <Boton onClick={() => setEditor(true)}>Nuevo comprobante</Boton>}
      </>}
    >
      <div className="filtros">
        <Campo etiqueta="Desde"><Entrada type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo etiqueta="Hasta"><Entrada type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
        <Campo etiqueta="Estado">
          <Selector value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todos</option><option value="borrador">Borrador</option><option value="contabilizado">Contabilizado</option><option value="anulado">Anulado</option>
          </Selector>
        </Campo>
        <Campo etiqueta="Buscar"><Entrada value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Número o glosa" /></Campo>
      </div>
      <Aviso tipo="error">{error}</Aviso>
      <Tarjeta>
        {cargando ? <Cargando /> : !filtrados.length ? <Vacio>No hay comprobantes en el rango.</Vacio> : (
          <table className="tabla">
            <thead><tr><th>N°</th><th>Fecha</th><th>Tipo</th><th>Glosa</th><th>Origen</th><th className="num">Monto</th><th>Estado</th></tr></thead>
            <tbody>
              {filtrados.map((a: any) => (
                <tr key={a.id} className="clic" onClick={() => setDetalle(a)}>
                  <td className="mono">{a.numero ?? '—'}</td>
                  <td>{fecha(a.fecha)}</td>
                  <td className="cap">{a.tipo}</td>
                  <td>{a.glosa}</td>
                  <td className="sub">{a.origen.replace('_', ' ')}</td>
                  <td className="num">{pesos(a.estado === 'borrador' ? a.asiento_lineas.reduce((s: number, l: any) => s + Number(l.debe), 0) : a.total_debe)}</td>
                  <td><Estado valor={a.estado} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tarjeta>

      {editor && <EditorAsiento onCerrar={() => setEditor(false)} onGuardado={() => { setEditor(false); recargar(); }} />}

      <Modal abierto={!!detalle} titulo={detalle ? `Comprobante ${detalle.numero ?? '(borrador)'}` : ''} onCerrar={() => setDetalle(null)} ancho={820}>
        {detalle && (
          <>
            <p><strong>{detalle.glosa}</strong> · {fecha(detalle.fecha)} · <Estado valor={detalle.estado} /></p>
            {detalle.motivo_anulacion && <Aviso tipo="alerta">Anulado: {detalle.motivo_anulacion}</Aviso>}
            <table className="tabla compacta">
              <thead><tr><th>Cuenta</th><th>Auxiliar</th><th>Glosa</th><th className="num">Debe</th><th className="num">Haber</th></tr></thead>
              <tbody>
                {[...detalle.asiento_lineas].sort((a: any, b: any) => a.linea - b.linea).map((l: any) => (
                  <tr key={l.id}>
                    <td><span className="mono">{l.cuentas.codigo}</span> {l.cuentas.nombre}</td>
                    <td>{l.auxiliares?.razon_social ?? ''}</td>
                    <td>{l.glosa ?? ''}{l.documento_folio ? ` (doc ${l.documento_tipo}-${l.documento_folio})` : ''}</td>
                    <td className="num">{Number(l.debe) ? pesos(l.debe) : ''}</td>
                    <td className="num">{Number(l.haber) ? pesos(l.haber) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="acciones fin">
              {detalle.estado === 'borrador' && puede('admin', 'contador', 'operador') && (
                <Boton variante="peligro" onClick={() => accion(async () => { const { error } = await supabase.from('asientos').delete().eq('id', detalle.id); if (error) throw new Error(error.message); })}>Eliminar borrador</Boton>
              )}
              {detalle.estado === 'borrador' && puede('admin', 'contador') && (
                <Boton onClick={() => accion(() => rpc('contabilizar_asiento', { p_id: detalle.id }))}>Contabilizar</Boton>
              )}
              {detalle.estado === 'contabilizado' && puede('admin', 'contador') && (
                <>
                  <Boton variante="secundario" onClick={() => { const m = prompt('Motivo de la anulación'); if (m) accion(() => rpc('anular_asiento', { p_id: detalle.id, p_motivo: m })); }}>Anular</Boton>
                  <Boton variante="secundario" onClick={() => { const m = prompt('Motivo del reverso (se crea un comprobante inverso con fecha de hoy)'); if (m) accion(() => rpc('reversar_asiento', { p_id: detalle.id, p_fecha: hoy(), p_motivo: m })); }}>Reversar</Boton>
                </>
              )}
            </div>
          </>
        )}
      </Modal>
    </Pagina>
  );
}

function EditorAsiento({ onCerrar, onGuardado }: { onCerrar: () => void; onGuardado: () => void }) {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const { datos } = useCarga(async () => ({ cuentas: (await cuentas(empresa.id)).filter((c) => c.imputable && c.activa), aux: await auxiliares(empresa.id), cc: await centrosCosto(empresa.id) }), [empresa.id]);
  const [cab, setCab] = useState({ fecha: hoy(), tipo: 'traspaso', glosa: '' });
  const [lineas, setLineas] = useState<Linea[]>([lineaVacia(), lineaVacia()]);
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  const debe = lineas.reduce((s, l) => s + (Number(l.debe) || 0), 0);
  const haber = lineas.reduce((s, l) => s + (Number(l.haber) || 0), 0);
  const cuadra = debe === haber && debe > 0;
  const mapaCuentas = useMemo(() => new Map((datos?.cuentas ?? []).map((c) => [c.id, c])), [datos]);

  const set = (i: number, k: keyof Linea, v: string) => setLineas(lineas.map((l, j) => (j === i ? { ...l, [k]: v, ...(k === 'debe' && v ? { haber: '' } : {}), ...(k === 'haber' && v ? { debe: '' } : {}) } : l)));

  async function guardar(contabilizar: boolean) {
    setError('');
    const validas = lineas.filter((l) => l.cuenta_id && (Number(l.debe) || Number(l.haber)));
    if (validas.length < 2) return setError('Ingrese al menos dos líneas con cuenta y monto');
    if (!cab.glosa.trim()) return setError('Ingrese la glosa');
    setGuardando(true);
    try {
      await rpc('crear_asiento', {
        p_empresa: empresa.id, p_fecha: cab.fecha, p_glosa: cab.glosa.trim(), p_tipo: cab.tipo, p_contabilizar: contabilizar,
        p_lineas: validas.map((l) => ({ cuenta_id: l.cuenta_id, debe: Number(l.debe) || 0, haber: Number(l.haber) || 0, glosa: l.glosa, auxiliar_id: l.auxiliar_id, centro_costo_id: l.centro_costo_id })),
      });
      onGuardado();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal abierto titulo="Nuevo comprobante" onCerrar={onCerrar} ancho={1100}>
      {!datos ? <Cargando /> : (
        <>
          <div className="grid-3 form">
            <Campo etiqueta="Fecha"><Entrada type="date" value={cab.fecha} onChange={(e) => setCab({ ...cab, fecha: e.target.value })} /></Campo>
            <Campo etiqueta="Tipo">
              <Selector value={cab.tipo} onChange={(e) => setCab({ ...cab, tipo: e.target.value })}>
                <option value="ingreso">Ingreso</option><option value="egreso">Egreso</option><option value="traspaso">Traspaso</option><option value="apertura">Apertura</option>
              </Selector>
            </Campo>
            <Campo etiqueta="Glosa"><Entrada value={cab.glosa} onChange={(e) => setCab({ ...cab, glosa: e.target.value })} maxLength={500} /></Campo>
          </div>
          <datalist id="dl-cuentas">{datos.cuentas.map((c) => <option key={c.id} value={`${c.codigo} ${c.nombre}`} />)}</datalist>
          <table className="tabla editor">
            <thead><tr><th style={{ width: '30%' }}>Cuenta</th><th>Auxiliar / C. costo</th><th>Glosa línea</th><th className="num">Debe</th><th className="num">Haber</th><th /></tr></thead>
            <tbody>
              {lineas.map((l, i) => {
                const c = mapaCuentas.get(l.cuenta_id);
                return (
                  <tr key={i}>
                    <td>
                      <Entrada list="dl-cuentas" defaultValue={c ? `${c.codigo} ${c.nombre}` : ''} placeholder="Código o nombre"
                        onChange={(e) => { const cod = e.target.value.split(' ')[0]; const enc = datos.cuentas.find((x) => x.codigo === cod); set(i, 'cuenta_id', enc?.id ?? ''); }} />
                    </td>
                    <td>
                      {c?.requiere_auxiliar && (
                        <Selector value={l.auxiliar_id} onChange={(e) => set(i, 'auxiliar_id', e.target.value)}>
                          <option value="">— auxiliar —</option>
                          {datos.aux.map((a) => <option key={a.id} value={a.id}>{a.razon_social}</option>)}
                        </Selector>
                      )}
                      {(c?.requiere_centro_costo || (datos.cc.length > 0 && c && ['gasto', 'ingreso'].includes(c.tipo))) && (
                        <Selector value={l.centro_costo_id} onChange={(e) => set(i, 'centro_costo_id', e.target.value)}>
                          <option value="">— centro de costo —</option>
                          {datos.cc.map((x) => <option key={x.id} value={x.id}>{x.codigo} {x.nombre}</option>)}
                        </Selector>
                      )}
                    </td>
                    <td><Entrada value={l.glosa} onChange={(e) => set(i, 'glosa', e.target.value)} /></td>
                    <td><Entrada className="num" inputMode="decimal" value={l.debe} onChange={(e) => set(i, 'debe', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                    <td><Entrada className="num" inputMode="decimal" value={l.haber} onChange={(e) => set(i, 'haber', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                    <td><button className="btn btn-fantasma" onClick={() => setLineas(lineas.filter((_, j) => j !== i))} aria-label="Quitar línea">✕</button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}><button className="enlace" onClick={() => setLineas([...lineas, lineaVacia()])}>+ Agregar línea</button></td>
                <td className="num">{pesos(debe)}</td><td className="num">{pesos(haber)}</td><td />
              </tr>
              <tr><td colSpan={6} className={cuadra ? 'ok-txt' : 'error-txt'}>{cuadra ? '✓ El comprobante cuadra' : `Diferencia: ${pesos(Math.abs(debe - haber))}`}</td></tr>
            </tfoot>
          </table>
          <Aviso tipo="error">{error}</Aviso>
          <div className="acciones fin">
            <Boton variante="secundario" onClick={() => guardar(false)} cargando={guardando}>Guardar borrador</Boton>
            {puede('admin', 'contador') && <Boton onClick={() => guardar(true)} disabled={!cuadra} cargando={guardando}>Guardar y contabilizar</Boton>}
          </div>
        </>
      )}
    </Modal>
  );
}
