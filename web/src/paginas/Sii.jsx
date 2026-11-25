import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { funcion, q, rpc, sb } from '../supabase';
import { csv, fecha, hoy, MESES_LARGOS, peso, rutFormato, rutValido, TIPOS_DOC } from '../util';
import { Aviso, CampoMonto, SelectorMes } from '../componentes';
import { leerArchivo, leerRcv } from '../importadores';

const MOTIVOS = { solo_en_sii: 'Está en el SII, falta en el libro', solo_en_libro: 'Está en el libro, no en el SII', monto_distinto: 'Montos distintos' };

export default function Sii() {
  const { permite } = useEmpresa();
  const pestañas = [
    permite('rcv.ver') && ['rcv', 'Registro de Compras y Ventas'],
    permite('sii.ver') && ['conexion', 'Conexión con el SII'],
    permite('sii.emitir') && ['emitir', 'Emitir documento'],
  ].filter(Boolean);
  const [vista, setVista] = useState(pestañas[0]?.[0]);
  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>SII</h1>
          <p className="chico">Cuadre el libro con el Registro de Compras y Ventas del SII y prepare la emisión electrónica.</p>
        </div>
        <div className="pestanas">{pestañas.map(([k, t]) => <button key={k} className={vista === k ? 'activa' : ''} onClick={() => setVista(k)}>{t}</button>)}</div>
      </header>
      {vista === 'rcv' && <Rcv />}
      {vista === 'conexion' && <Conexion />}
      {vista === 'emitir' && <Emitir />}
    </section>
  );
}

// ---------------------------------------------------------------------------
function Rcv() {
  const { empresa, permite } = useEmpresa();
  const [mes, setMes] = useState(() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 7); });
  const [op, setOp] = useState('COMPRA');
  const [cuad, setCuad] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [marcados, setMarcados] = useState(new Set());
  const [msg, setMsg] = useState(null);
  const periodo = mes.replace('-', '');
  const importa = permite('rcv.importar');

  const cargar = useCallback(async () => {
    setCuad(await rpc('cuadratura_rcv', { p_empresa: empresa.id, p_periodo: periodo, p_operacion: op }));
    setMarcados(new Set());
  }, [empresa.id, periodo, op]);
  useEffect(() => { setPrevia(null); cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  async function archivo(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.size > 5_000_000) throw new Error('El archivo es demasiado grande (máximo 5 MB).');
      const filas = leerRcv(await leerArchivo(f));
      if (!filas.length) throw new Error('El archivo no tiene documentos.');
      const fuera = filas.filter((r) => r.fechaEmision && r.fechaEmision.slice(0, 7) !== mes).length;
      setPrevia({ nombre: f.name, filas, fuera });
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function importar() {
    try {
      const r = await rpc('importar_rcv', { p_empresa: empresa.id, p_periodo: periodo, p_operacion: op, p_filas: previa.filas });
      setPrevia(null);
      setCuad(r.cuadratura);
      setMsg({ ok: true, t: `${r.importados} documentos del RCV cargados para ${MESES_LARGOS[Number(mes.slice(5)) - 1]}.` });
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function descargarSii() {
    try {
      setMsg({ t: 'Consultando el SII…' });
      const r = await funcion('rcv-sync', { empresaId: empresa.id, periodo, operacion: op });
      setCuad(r.cuadratura);
      setMsg({ ok: true, t: `${r.importados} documentos descargados desde el SII.` + (r.fallos?.length ? ` Algunos tipos no respondieron (${r.fallos.length}).` : '') });
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function registrar() {
    try {
      const r = await rpc('registrar_desde_rcv', { p_empresa: empresa.id, p_ids: [...marcados] });
      setMsg({ ok: r.errores.length === 0, t: `${r.registrados} documentos registrados en el libro.` + (r.errores.length ? ' No se pudieron registrar: ' + r.errores.map((x) => `${x.tipo}-${x.folio} (${x.error})`).join('; ') : '') });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  const r = cuad?.resumen;
  const registrables = (cuad?.diferencias ?? []).filter((d) => d.motivo === 'solo_en_sii' && [33, 34, 46].includes(d.tipo));
  return (
    <>
      <div className="filtros fila">
        <SelectorMes valor={mes} alCambiar={setMes} etiqueta="Período" />
        <label>Registro<select value={op} onChange={(e) => setOp(e.target.value)}><option value="COMPRA">Compras</option><option value="VENTA">Ventas</option></select></label>
        {importa && <label className="boton-archivo">Importar CSV del SII<input type="file" accept=".csv,text/csv" onChange={archivo} hidden /></label>}
        {importa && <button onClick={descargarSii} title="Requiere certificado digital y ambiente de producción">Descargar desde el SII</button>}
      </div>
      <p className="chico">En sii.cl › Servicios online › Factura electrónica › Registro de Compras y Ventas, elija el período, abra {op === 'COMPRA' ? 'Compras' : 'Ventas'} y use “Descargar detalles”. Importe aquí ese archivo CSV.</p>
      <Aviso msg={msg} />

      {previa && (
        <div className="formulario">
          <h2>{previa.nombre}: {previa.filas.length} documentos</h2>
          {previa.fuera > 0 && <p className="aviso error">{previa.fuera} documentos tienen fecha fuera de {MESES_LARGOS[Number(mes.slice(5)) - 1]}: revise que eligió el período correcto.</p>}
          <p>Total {peso(previa.filas.reduce((s, f) => s + f.total, 0))} · IVA {peso(previa.filas.reduce((s, f) => s + f.iva, 0))}. Reemplaza la carga anterior de este período.</p>
          <div className="acciones"><button onClick={() => setPrevia(null)}>Cancelar</button><button className="primario" onClick={importar}>Importar</button></div>
        </div>
      )}

      {cuad && !cuad.importado && <p className="vacio-grande">Aún no se importa el RCV de {op === 'COMPRA' ? 'compras' : 'ventas'} de este período.</p>}
      {cuad?.importado && (
        <>
          <p className="chico">Importado el {fecha(cuad.importado)} {String(cuad.importado).slice(11, 16)}</p>
          <div className="comparacion">
            <div><span>Coinciden</span><b>{r.cuadran}</b></div>
            <div className={r.soloEnSii ? 'dif' : ''}><span>Faltan en el libro</span><b>{r.soloEnSii}</b></div>
            <div className={r.soloEnLibro ? 'dif' : ''}><span>No están en el SII</span><b>{r.soloEnLibro}</b></div>
            <div className={r.montoDistinto ? 'dif' : ''}><span>Montos distintos</span><b>{r.montoDistinto}</b></div>
            <div className={r.ivaSii !== r.ivaLibro ? 'dif' : ''}><span>IVA SII / libro</span><b>{peso(r.ivaSii)}</b><small>Libro: {peso(r.ivaLibro)}</small></div>
          </div>
          {(cuad.boletas.sii > 0 || cuad.boletas.libro > 0) && <p className="chico">Boletas (se comparan por total del mes): SII {peso(cuad.boletas.sii)} · libro {peso(cuad.boletas.libro)}</p>}
          {cuad.diferencias.length === 0 ? <p className="aviso ok">El libro cuadra con el RCV del SII.</p> : (
            <>
              <div className="scroll"><table className="tabla">
                <thead><tr><th></th><th>Diferencia</th><th>Documento</th><th>Contraparte</th><th>Fecha</th><th className="n">Total SII</th><th className="n">Total libro</th></tr></thead>
                <tbody>{cuad.diferencias.map((d, i) => (
                  <tr key={i}>
                    <td>{d.motivo === 'solo_en_sii' && [33, 34, 46].includes(d.tipo) && permite('documentos.registrar') &&
                      <input type="checkbox" aria-label="Registrar en el libro" checked={marcados.has(d.rcvId)} onChange={(e) => { const s = new Set(marcados); e.target.checked ? s.add(d.rcvId) : s.delete(d.rcvId); setMarcados(s); }} />}</td>
                    <td>{MOTIVOS[d.motivo]}{d.estadoSii === 'PENDIENTE' && <small> · pendiente en el SII</small>}{d.asientoEstado === 'borrador' && <small> · por aprobar</small>}</td>
                    <td className="nw" title={TIPOS_DOC[d.tipo]}>{d.tipo} N° {d.folio}</td>
                    <td>{d.razonSocial}<small> · {rutFormato(d.rut)}</small></td>
                    <td className="nw">{fecha(d.fecha)}</td>
                    <td className="n">{peso(d.totalSii)}</td><td className="n">{peso(d.totalLibro)}</td>
                  </tr>))}</tbody>
              </table></div>
              <div className="acciones izquierda">
                {registrables.length > 0 && permite('documentos.registrar') && <>
                  <button onClick={() => setMarcados(new Set(registrables.map((d) => d.rcvId)))}>Marcar los {registrables.length} faltantes</button>
                  <button className="primario" disabled={!marcados.size} onClick={registrar}>Registrar {marcados.size || ''} en el libro</button>
                </>}
                <button onClick={() => csv(`cuadratura_rcv_${op.toLowerCase()}_${periodo}`, cuad.diferencias.map((d) => ({ Diferencia: MOTIVOS[d.motivo], Tipo: d.tipo, Folio: d.folio, RUT: rutFormato(d.rut), RazonSocial: d.razonSocial, Fecha: fecha(d.fecha), TotalSII: d.totalSii, TotalLibro: d.totalLibro })))}>Descargar CSV</button>
              </div>
              <p className="chico">Las notas de crédito y débito que faltan se registran a mano en Compras y ventas, indicando la factura que modifican.</p>
            </>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function Conexion() {
  const { empresa, permite } = useEmpresa();
  const [e, setE] = useState(null);
  const [f, setF] = useState(null);
  const [cert, setCert] = useState(null);
  const [clave, setClave] = useState('');
  const [msg, setMsg] = useState(null);
  const admin = permite('sii.configurar');

  const cargar = useCallback(async () => {
    const r = await rpc('estado_sii', { p_empresa: empresa.id });
    setE(r);
    setF({ conector: r.conector, ambiente: r.ambiente, proveedor: r.proveedor ?? 'openfactura', url: r.proveedorUrl ?? '',
      resNum: String(r.resolucionNumero ?? 0), resFecha: r.resolucionFecha ?? '', rutEnvia: r.rutEnvia ? rutFormato(r.rutEnvia) : '', actecos: (r.actecos ?? []).join(', ') });
  }, [empresa.id]);
  useEffect(() => { cargar().catch((err) => setMsg({ ok: false, t: err.message })); }, [cargar]);

  async function guardar(ev) {
    ev.preventDefault();
    try {
      const actecos = f.actecos.split(/[,\s]+/).filter(Boolean).map(Number);
      if (f.rutEnvia && !rutValido(f.rutEnvia)) throw new Error('El RUT de quien envía no es válido.');
      await rpc('configurar_sii', { p_empresa: empresa.id, p_conector: f.conector, p_ambiente: f.ambiente,
        p_proveedor: f.conector === 'proveedor' ? f.proveedor : null, p_proveedor_url: f.url || null,
        p_resolucion_numero: Number(f.resNum || 0), p_resolucion_fecha: f.resFecha || null, p_rut_envia: f.rutEnvia || '', p_actecos: actecos });
      setMsg({ ok: true, t: 'Configuración guardada.' });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function subir(accion, body, ok) {
    try { await funcion('credenciales', { empresaId: empresa.id, accion, ...body }); setMsg({ ok: true, t: ok }); cargar(); }
    catch (err) { setMsg({ ok: false, t: err.message }); }
  }
  const leerBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });

  async function probar() {
    try { const r = await funcion('sii-probar', { empresaId: empresa.id }); setMsg({ ok: true, t: r.mensaje }); }
    catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  if (!e || !f) return <><Aviso msg={msg} /><p>Cargando…</p></>;
  return (
    <>
      <Aviso msg={msg} />
      <h2>{e.listo ? 'Lista para operar con el SII' : 'Qué falta para operar con el SII'}</h2>
      <ul className="lista-chequeo">{e.items.map((i) => <li key={i.clave} className={i.ok ? 'ok' : ''}>{i.texto}</li>)}</ul>

      <form className="formulario rejilla" onSubmit={guardar}>
        <label className="ancho">Forma de conexión<select value={f.conector} onChange={(ev) => setF({ ...f, conector: ev.target.value })} disabled={!admin}>
          <option value="ninguno">Sin conexión (registro manual)</option>
          <option value="directo">Directa al SII (certificado digital y folios propios)</option>
          <option value="proveedor">Vía proveedor de facturación electrónica</option>
        </select></label>
        <label>Ambiente<select value={f.ambiente} onChange={(ev) => setF({ ...f, ambiente: ev.target.value })} disabled={!admin}>
          <option value="certificacion">Certificación (pruebas)</option><option value="produccion">Producción</option>
        </select></label>
        <label data-ayuda="Códigos de actividad económica de 6 dígitos que aparecen en su inicio de actividades (hasta 4).">Acteco<input value={f.actecos} onChange={(ev) => setF({ ...f, actecos: ev.target.value })} placeholder="620200" disabled={!admin} /></label>
        {f.conector === 'proveedor' && <>
          <label>Proveedor<select value={f.proveedor} onChange={(ev) => setF({ ...f, proveedor: ev.target.value })} disabled={!admin}>
            <option value="openfactura">OpenFactura (Haulmer)</option><option value="libredte">LibreDTE</option>
          </select></label>
          <label className="ancho" data-ayuda="Déjelo vacío para usar la dirección oficial del proveedor según el ambiente.">Dirección de la API (opcional)<input value={f.url} onChange={(ev) => setF({ ...f, url: ev.target.value })} placeholder="https://…" disabled={!admin} /></label>
        </>}
        {f.conector === 'directo' && <>
          <label data-ayuda="En certificación es 0. En producción, el número de la resolución que autoriza a la empresa como emisor electrónico.">N° de resolución<input inputMode="numeric" value={f.resNum} onChange={(ev) => setF({ ...f, resNum: ev.target.value.replace(/\D/g, '') })} disabled={!admin} /></label>
          <label>Fecha de resolución<input type="date" value={f.resFecha} onChange={(ev) => setF({ ...f, resFecha: ev.target.value })} disabled={!admin} /></label>
          <label data-ayuda="RUT de la persona dueña del certificado digital que firma los envíos.">RUT de quien envía<input value={f.rutEnvia} onChange={(ev) => setF({ ...f, rutEnvia: ev.target.value })} onBlur={() => setF({ ...f, rutEnvia: rutFormato(f.rutEnvia) })} disabled={!admin} /></label>
        </>}
        {admin && <div className="acciones ancho"><button className="primario">Guardar configuración</button></div>}
      </form>

      {e.conector === 'directo' && (
        <>
          <h2>Certificado digital</h2>
          <p>{e.certificado ? <>Cargado: <b>{e.certificado.titular}</b> ({rutFormato(e.certificado.rut)}), vence el {fecha(e.certificado.validoHasta)}.</> : 'Aún no se carga un certificado.'}</p>
          {admin && (
            <form className="formulario rejilla" onSubmit={async (ev) => { ev.preventDefault(); await subir('certificado', { pfxBase64: await leerBase64(cert), clave }, 'Certificado cargado y cifrado.'); setClave(''); setCert(null); }}>
              <label>Archivo .pfx o .p12<input type="file" accept=".pfx,.p12" onChange={(ev) => setCert(ev.target.files?.[0] ?? null)} required /></label>
              <label>Clave del certificado<input type="password" autoComplete="off" value={clave} onChange={(ev) => setClave(ev.target.value)} required /></label>
              <div className="acciones ancho"><button className="primario" disabled={!cert || !clave}>Cargar certificado</button></div>
              <p className="ancho chico">El certificado y su clave se cifran en el servidor y nunca vuelven al navegador.</p>
            </form>
          )}
          <h2>Folios autorizados (CAF)</h2>
          {e.cafs.length === 0 ? <p>No hay folios disponibles. Descárguelos en sii.cl › Factura electrónica › Timbraje electrónico.</p> : (
            <table className="tabla"><thead><tr><th>Tipo</th><th className="n">Desde</th><th className="n">Hasta</th><th className="n">Disponibles</th><th>Autorizado</th></tr></thead>
              <tbody>{e.cafs.map((c) => <tr key={`${c.tipo}-${c.desde}`}><td>{TIPOS_DOC[c.tipo] ?? c.tipo}</td><td className="n">{c.desde}</td><td className="n">{c.hasta}</td><td className="n">{c.disponibles}</td><td>{fecha(c.autorizado)}</td></tr>)}</tbody></table>
          )}
          {admin && <label className="boton-archivo">Cargar archivo CAF (.xml)<input type="file" accept=".xml" hidden onChange={async (ev) => {
            const file = ev.target.files?.[0]; ev.target.value = ''; if (file) await subir('caf', { xml: await leerArchivo(file) }, 'Folios cargados.');
          }} /></label>}
        </>
      )}

      {e.conector === 'proveedor' && admin && (
        <>
          <h2>Clave de API del proveedor</h2>
          <p>{e.apiKey ? 'Hay una clave cargada. Cargar otra la reemplaza.' : 'Aún no se carga la clave.'}</p>
          <form className="formulario rejilla" onSubmit={async (ev) => { ev.preventDefault(); await subir('api_key', { apiKey: clave }, 'Clave de API cargada y cifrada.'); setClave(''); }}>
            <label className="ancho">Clave de API<input type="password" autoComplete="off" value={clave} onChange={(ev) => setClave(ev.target.value)} required minLength={16} /></label>
            <div className="acciones ancho"><button className="primario" disabled={clave.length < 16}>Guardar clave</button></div>
          </form>
        </>
      )}

      {e.conector !== 'ninguno' && <div className="acciones izquierda"><button onClick={probar}>Probar conexión</button></div>}
      <p className="chico">Pasos con el SII: inscribirse como facturador electrónico, obtener el certificado digital del representante y, en conexión directa, completar la certificación en el ambiente de pruebas (maullin.sii.cl) antes de pasar a producción. Con un proveedor, ese proceso lo guía el proveedor.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
const itemVacio = () => ({ nombre: '', cantidad: '1', precio: '' });

function Emitir() {
  const { empresa, permite } = useEmpresa();
  const [estado, setEstado] = useState(null);
  const [ventas, setVentas] = useState([]);
  const [f, setF] = useState({ tipo: '33', rut: '', razon: '', giro: '', direccion: '', comuna: '', correo: '', plazo: '0', ref: '', razonRef: 'Corrige montos', items: [itemVacio()] });
  const [msg, setMsg] = useState(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => { rpc('estado_sii', { p_empresa: empresa.id }).then(setEstado).catch((err) => setMsg({ ok: false, t: err.message })); }, [empresa.id]);
  useEffect(() => {
    if (['56', '61'].includes(f.tipo)) q(sb.from('documentos').select('id, tipo, folio, fecha, rut, razon_social, total').eq('empresa_id', empresa.id)
      .eq('operacion', 'venta').eq('estado', 'vigente').in('tipo', [33, 34]).order('fecha', { ascending: false }).limit(200)).then(setVentas).catch(() => {});
  }, [empresa.id, f.tipo]);

  const exenta = f.tipo === '34';
  const neto = f.items.reduce((s, i) => s + Math.round(Number(i.cantidad || 0) * Number(i.precio || 0)), 0);
  const iva = exenta ? 0 : Math.round(neto * 0.19);
  const setItem = (i, k, v) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });

  async function emitir(ev) {
    ev.preventDefault();
    if (!rutValido(f.rut)) return setMsg({ ok: false, t: 'El RUT del receptor no es válido.' });
    setEnviando(true);
    try {
      const venc = Number(f.plazo) > 0 ? new Date(Date.now() + Number(f.plazo) * 86400000).toISOString().slice(0, 10) : undefined;
      const r = await funcion('dte-emitir', {
        empresaId: empresa.id,
        documento: {
          tipo: Number(f.tipo), formaPago: Number(f.plazo) > 0 ? 2 : 1, fechaVencimiento: venc,
          receptor: { rut: f.rut, razonSocial: f.razon, giro: f.giro || undefined, direccion: f.direccion || undefined, comuna: f.comuna || undefined, correo: f.correo || undefined },
          items: f.items.map((i) => ({ nombre: i.nombre, cantidad: Number(i.cantidad), precio: Number(i.precio) })),
          referenciaDocumentoId: f.ref || undefined,
          referencias: f.ref ? [{ razon: f.razonRef }] : undefined,
        },
      });
      setMsg({ ok: !r.avisoLibro, t: r.avisoLibro ?? `Emitido ${TIPOS_DOC[r.dte.tipo]} N° ${r.dte.folio} por ${peso(r.dte.total)}${r.dte.track_id ? ` (Track ID ${r.dte.track_id})` : ''}. Quedó registrado en el libro de ventas.` });
      setF({ ...f, items: [itemVacio()], ref: '' });
    } catch (err) { setMsg({ ok: false, t: err.message + (err.detalle ? ' · ' + JSON.stringify(err.detalle).slice(0, 300) : '') }); }
    setEnviando(false);
  }

  if (!estado) return <><Aviso msg={msg} /><p>Cargando…</p></>;
  if (!estado.listo) return <p className="vacio-grande">Para emitir, complete primero la pestaña “Conexión con el SII”.{estado.ambiente === 'certificacion' ? '' : ''}</p>;
  return (
    <form className="formulario" onSubmit={emitir}>
      <Aviso msg={msg} />
      {estado.ambiente === 'certificacion' && <p className="aviso">Ambiente de certificación: los documentos son de prueba y no tienen validez tributaria.</p>}
      <div className="rejilla">
        <label>Tipo<select value={f.tipo} onChange={(ev) => setF({ ...f, tipo: ev.target.value, ref: '' })}>
          {[33, 34, 61, 56].map((t) => <option key={t} value={t}>{TIPOS_DOC[t]}</option>)}
        </select></label>
        {['56', '61'].includes(f.tipo) && <>
          <label className="ancho">Factura que modifica<select value={f.ref} required onChange={(ev) => {
            const d = ventas.find((v) => v.id === ev.target.value);
            setF({ ...f, ref: ev.target.value, rut: d ? rutFormato(d.rut) : f.rut, razon: d?.razon_social ?? f.razon });
          }}>
            <option value="">Elegir…</option>
            {ventas.map((v) => <option key={v.id} value={v.id}>{v.tipo} N° {v.folio} · {fecha(v.fecha)} · {v.razon_social} · {peso(v.total)}</option>)}
          </select></label>
          <label className="ancho">Razón de la nota<input value={f.razonRef} onChange={(ev) => setF({ ...f, razonRef: ev.target.value })} maxLength={90} required /></label>
        </>}
        <label>RUT receptor<input value={f.rut} onChange={(ev) => setF({ ...f, rut: ev.target.value })} onBlur={() => setF({ ...f, rut: rutFormato(f.rut) })} required /></label>
        <label className="ancho">Razón social<input value={f.razon} onChange={(ev) => setF({ ...f, razon: ev.target.value })} required maxLength={100} /></label>
        <label>Giro<input value={f.giro} onChange={(ev) => setF({ ...f, giro: ev.target.value })} maxLength={40} /></label>
        <label>Dirección<input value={f.direccion} onChange={(ev) => setF({ ...f, direccion: ev.target.value })} maxLength={70} /></label>
        <label>Comuna<input value={f.comuna} onChange={(ev) => setF({ ...f, comuna: ev.target.value })} maxLength={20} /></label>
        <label>Correo (envío del PDF)<input type="email" value={f.correo} onChange={(ev) => setF({ ...f, correo: ev.target.value })} /></label>
        <label>Condición de pago<select value={f.plazo} onChange={(ev) => setF({ ...f, plazo: ev.target.value })}><option value="0">Contado</option><option value="30">Crédito 30 días</option><option value="60">Crédito 60 días</option></select></label>
      </div>
      <table className="tabla tabla-edicion">
        <thead><tr><th>Detalle</th><th className="n">Cantidad</th><th className="n">Precio unitario {exenta ? '' : 'neto'}</th><th className="n">Total</th><th></th></tr></thead>
        <tbody>{f.items.map((i, k) => (
          <tr key={k}>
            <td><input aria-label="Detalle" value={i.nombre} onChange={(ev) => setItem(k, 'nombre', ev.target.value)} required maxLength={80} /></td>
            <td><input aria-label="Cantidad" inputMode="decimal" value={i.cantidad} onChange={(ev) => setItem(k, 'cantidad', ev.target.value.replace(/[^\d.]/g, ''))} required /></td>
            <td><CampoMonto aria-label="Precio" valor={i.precio} alCambiar={(v) => setItem(k, 'precio', v)} required /></td>
            <td className="n">{peso(Math.round(Number(i.cantidad || 0) * Number(i.precio || 0)))}</td>
            <td>{f.items.length > 1 && <button type="button" className="enlace" onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== k) })}>Quitar</button>}</td>
          </tr>))}</tbody>
      </table>
      <div className="acciones izquierda"><button type="button" onClick={() => setF({ ...f, items: [...f.items, itemVacio()] })}>+ Agregar línea</button></div>
      <p>{exenta ? 'Exento' : 'Neto'} {peso(neto)}{exenta ? '' : ` · IVA ${peso(iva)}`} · <b>Total {peso(neto + iva)}</b></p>
      <div className="acciones"><button className="primario" disabled={enviando || !permite('sii.emitir')}>{enviando ? 'Emitiendo…' : 'Emitir y enviar al SII'}</button></div>
    </form>
  );
}
