import { useState } from 'react';
import { supabase, llamarFuncion, rpc } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { cuentas } from '../lib/maestros';
import { pesos, fecha, fechaHora, descargar, leerArchivo, NOMBRE_DTE } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Selector, Estado, Aviso, Modal, Vacio, Cargando, useCarga } from '../components/ui';

const diasDesde = (s: string) => Math.floor((Date.now() - new Date(s).getTime()) / 86400000);

export function Recibidos() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const [estado, setEstado] = useState('pendiente');
  const [ver, setVer] = useState<any | null>(null);
  const [cuentaGasto, setCuentaGasto] = useState('');
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error' | 'alerta'; txt: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const { datos: plan } = useCarga(async () => (await cuentas(empresa.id)).filter((c) => c.imputable && (c.tipo === 'gasto' || c.codigo.startsWith('1.1.04') || c.codigo.startsWith('1.2'))), [empresa.id]);

  const { datos, cargando, recargar } = useCarga(async () => {
    let q = supabase.from('dte_recibidos').select('id, tipo, folio, fecha_emision, fecha_recepcion, emisor_rut, emisor_razon, neto, exento, iva, iva_no_recuperable, total, estado, origen, asiento_id, accion_sii, accion_en')
      .eq('empresa_id', empresa.id).order('fecha_recepcion', { ascending: false }).limit(300);
    if (estado) q = q.eq('estado', estado);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  }, [empresa.id, estado]);

  async function ejecutar(fn: () => Promise<string>) {
    setMsg(null);
    setOcupado(true);
    try {
      setMsg({ tipo: 'ok', txt: await fn() });
      setVer(null);
      recargar();
    } catch (e) {
      setMsg({ tipo: 'error', txt: (e as Error).message });
    } finally {
      setOcupado(false);
    }
  }

  async function importar(archivos: FileList | null) {
    if (!archivos?.length) return;
    await ejecutar(async () => {
      const partes: string[] = [];
      for (const f of Array.from(archivos)) {
        const xml = await leerArchivo(f, 'latin1');
        const r = await llamarFuncion('dte-recibir', { empresaId: empresa.id, accion: 'importar', xml, nombreArchivo: f.name });
        partes.push(`${f.name}: ${r.importados} nuevo(s), ${r.duplicados} repetido(s)`);
        if (r.respuestaXml) descargar(`RespuestaDTE_${f.name}`, r.respuestaXml);
      }
      return partes.join(' · ') + '. Se descargó el acuse de recepción para devolver al emisor.';
    });
  }

  const accionSii = (accion: 'aceptar' | 'reclamar' | 'recibo', tipoReclamo?: string) =>
    ejecutar(async () => {
      const r = await llamarFuncion('dte-recibir', { empresaId: empresa.id, accion, recibidoId: ver.id, tipoReclamo });
      if (r.recibosXml) descargar(`EnvioRecibos_${ver.tipo}_${ver.folio}.xml`, r.recibosXml);
      return `SII: ${r.respuesta || 'acción registrada'}`;
    });

  return (
    <Pagina titulo="Documentos recibidos" sub="Facturas de proveedores. Tiene 8 días desde la recepción en el SII para aceptarlas o reclamarlas."
      acciones={puede('admin', 'contador', 'operador') && (
        <label className="btn btn-primario">
          Importar XML de proveedor
          <input type="file" accept=".xml,text/xml" multiple hidden onChange={(e) => importar(e.target.files)} />
        </label>
      )}>
      <div className="filtros">
        <Campo etiqueta="Estado">
          <Selector value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todos</option><option value="pendiente">Pendientes</option><option value="aceptado">Aceptados</option><option value="recibo_mercaderias">Con recibo de mercaderías</option><option value="reclamado">Reclamados</option>
          </Selector>
        </Campo>
      </div>
      {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
      <Tarjeta>
        {cargando ? <Cargando /> : !datos?.length ? <Vacio>No hay documentos. Importe los XML que llegan al correo de intercambio o sincronice el RCV.</Vacio> : (
          <table className="tabla">
            <thead><tr><th>Recepción</th><th>Documento</th><th>Proveedor</th><th className="num">Total</th><th>Estado</th><th>Contab.</th></tr></thead>
            <tbody>
              {datos.map((d: any) => {
                const dias = diasDesde(d.fecha_recepcion);
                return (
                  <tr key={d.id} className="clic" onClick={() => { setVer(d); setMsg(null); }}>
                    <td>{fecha(d.fecha_recepcion)}{d.estado === 'pendiente' && <div className={`pequeno ${dias >= 6 ? 'error-txt' : 'sub'}`}>{dias >= 8 ? 'plazo vencido (aceptación tácita)' : `quedan ${8 - dias} día(s)`}</div>}</td>
                    <td>{NOMBRE_DTE[d.tipo] ?? d.tipo} <span className="mono">N° {d.folio}</span><div className="sub pequeno">{fecha(d.fecha_emision)} · {d.origen}</div></td>
                    <td>{d.emisor_razon}<div className="sub mono pequeno">{d.emisor_rut}</div></td>
                    <td className="num">{pesos(d.total)}</td>
                    <td><Estado valor={d.estado} /></td>
                    <td>{d.asiento_id ? '✓' : <span className="sub">pendiente</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Tarjeta>

      <Modal abierto={!!ver} titulo={ver ? `${NOMBRE_DTE[ver.tipo] ?? ver.tipo} N° ${ver.folio} — ${ver.emisor_razon}` : ''} onCerrar={() => setVer(null)} ancho={720}>
        {ver && (
          <>
            <dl className="ratios">
              <dt>Fecha emisión</dt><dd>{fecha(ver.fecha_emision)}</dd>
              <dt>Neto</dt><dd>{pesos(ver.neto)}</dd>
              <dt>Exento</dt><dd>{pesos(ver.exento)}</dd>
              <dt>IVA</dt><dd>{pesos(ver.iva)}</dd>
              {Number(ver.iva_no_recuperable) > 0 && <><dt>IVA no recuperable</dt><dd>{pesos(ver.iva_no_recuperable)}</dd></>}
              <dt className="fuerte">Total</dt><dd className="fuerte">{pesos(ver.total)}</dd>
              {ver.accion_sii && <><dt>Acción SII</dt><dd>{ver.accion_sii} · {fechaHora(ver.accion_en)}</dd></>}
            </dl>
            {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
            {puede('admin', 'contador') && ver.estado === 'pendiente' && (
              <Tarjeta titulo="Aceptación o reclamo (Ley 19.983)">
                <div className="acciones">
                  <Boton onClick={() => accionSii('aceptar')} cargando={ocupado}>Aceptar contenido</Boton>
                  <Boton variante="secundario" onClick={() => accionSii('recibo')} cargando={ocupado}>Otorgar recibo de mercaderías</Boton>
                  <Boton variante="peligro" onClick={() => accionSii('reclamar', 'RCD')} cargando={ocupado}>Reclamar contenido</Boton>
                  <Boton variante="peligro" onClick={() => accionSii('reclamar', 'RFP')} cargando={ocupado}>Falta parcial</Boton>
                  <Boton variante="peligro" onClick={() => accionSii('reclamar', 'RFT')} cargando={ocupado}>Falta total</Boton>
                </div>
              </Tarjeta>
            )}
            {puede('admin', 'contador') && !ver.asiento_id && ver.estado !== 'reclamado' && (
              <Tarjeta titulo="Contabilizar">
                <div className="fila-form">
                  <Campo etiqueta="Cuenta de gasto o activo">
                    <Selector value={cuentaGasto} onChange={(e) => setCuentaGasto(e.target.value)}>
                      <option value="">Cuenta por defecto (gastos generales)</option>
                      {(plan ?? []).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
                    </Selector>
                  </Campo>
                  <Boton onClick={() => ejecutar(async () => { await rpc('contabilizar_dte_recibido', { p_dte: ver.id, p_cuenta_gasto: cuentaGasto || null }); return 'Documento contabilizado'; })} cargando={ocupado}>Contabilizar</Boton>
                </div>
              </Tarjeta>
            )}
          </>
        )}
      </Modal>
    </Pagina>
  );
}
