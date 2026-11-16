import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, llamarFuncion, rpc } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { pesos, fecha, fechaHora, descargar, csv, NOMBRE_DTE, periodoActual } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Estado, Aviso, Modal, Vacio, Cargando, useCarga } from '../components/ui';
import { Impreso } from '../components/Impreso';

export function Emitidos() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [periodo, setPeriodo] = useState(periodoActual());
  const [estado, setEstado] = useState('');
  const [ver, setVer] = useState<any | null>(null);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const { datos, cargando, recargar } = useCarga(async () => {
    const ini = `${periodo.slice(0, 4)}-${periodo.slice(4)}-01`;
    const fin = new Date(Date.UTC(+periodo.slice(0, 4), +periodo.slice(4), 0)).toISOString().slice(0, 10);
    let q = supabase.from('dte_emitidos').select('id, tipo, folio, fecha_emision, receptor_rut, receptor_razon, neto, exento, iva, total, estado, track_id, sii_glosa, asiento_id, enviado_en, ambiente')
      .eq('empresa_id', empresa.id).gte('fecha_emision', ini).lte('fecha_emision', fin).order('fecha_emision', { ascending: false }).order('folio', { ascending: false });
    if (estado) q = q.eq('estado', estado);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  }, [empresa.id, periodo, estado]);

  async function abrir(id: string) {
    const { data } = await supabase.from('dte_emitidos').select('*').eq('id', id).single();
    setVer(data);
  }
  useEffect(() => {
    const id = params.get('ver');
    if (id) abrir(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ejecutar(fn: () => Promise<string>) {
    setMsg(null);
    setOcupado(true);
    try {
      setMsg({ tipo: 'ok', txt: await fn() });
      recargar();
      if (ver) abrir(ver.id);
    } catch (e) {
      setMsg({ tipo: 'error', txt: (e as Error).message });
    } finally {
      setOcupado(false);
    }
  }

  const consultar = () => ejecutar(async () => {
    const r = await llamarFuncion('dte-estado', { empresaId: empresa.id, accion: 'consultar' });
    return r.resultados.length ? r.resultados.map((x: any) => `Track ${x.trackId}: ${x.estado} ${x.glosa}`).join(' · ') : 'No hay envíos pendientes de respuesta';
  });

  return (
    <Pagina titulo="Documentos emitidos" sub="Estado en el SII, representación impresa, XML y contabilización."
      acciones={<>
        <Boton variante="secundario" onClick={() => csv(`emitidos_${periodo}.csv`, datos ?? [])}>Exportar CSV</Boton>
        <Boton variante="secundario" onClick={consultar} cargando={ocupado}>Actualizar estados SII</Boton>
        <Boton onClick={() => nav('/emitir')}>Emitir</Boton>
      </>}>
      <div className="filtros">
        <Campo etiqueta="Período"><Entrada type="month" value={`${periodo.slice(0, 4)}-${periodo.slice(4)}`} onChange={(e) => setPeriodo(e.target.value.replace('-', ''))} /></Campo>
        <Campo etiqueta="Estado">
          <Selector value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todos</option>
            {['firmado', 'enviado', 'aceptado', 'aceptado_reparos', 'rechazado'].map((e) => <option key={e} value={e}>{e.replace('_', ' ')}</option>)}
          </Selector>
        </Campo>
      </div>
      {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
      <Tarjeta>
        {cargando ? <Cargando /> : !datos?.length ? <Vacio>No hay documentos en el período.</Vacio> : (
          <table className="tabla">
            <thead><tr><th>Fecha</th><th>Documento</th><th>Receptor</th><th className="num">Total</th><th>SII</th><th>Contab.</th></tr></thead>
            <tbody>
              {datos.map((d: any) => (
                <tr key={d.id} className="clic" onClick={() => abrir(d.id)}>
                  <td>{fecha(d.fecha_emision)}</td>
                  <td>{NOMBRE_DTE[d.tipo]} <span className="mono">N° {d.folio}</span></td>
                  <td>{d.receptor_razon}<div className="sub mono pequeno">{d.receptor_rut}</div></td>
                  <td className="num">{pesos(d.total)}</td>
                  <td><Estado valor={d.estado} />{d.track_id && <div className="sub pequeno mono">Track {d.track_id}</div>}</td>
                  <td>{d.asiento_id ? '✓' : d.tipo === 52 ? '—' : <span className="sub">pendiente</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tarjeta>

      <Modal abierto={!!ver} titulo={ver ? `${NOMBRE_DTE[ver.tipo]} N° ${ver.folio}` : ''} onCerrar={() => setVer(null)} ancho={900}>
        {ver && (
          <>
            <div className="barra-acciones no-imprimir">
              <Estado valor={ver.estado} />
              {ver.sii_glosa && <span className="sub">{ver.sii_glosa}</span>}
              {ver.enviado_en && <span className="sub">Enviado {fechaHora(ver.enviado_en)}</span>}
              <span className="espacio" />
              <Boton variante="secundario" onClick={() => window.print()}>Imprimir / PDF</Boton>
              <Boton variante="secundario" onClick={() => descargar(`DTE_${ver.tipo}_${ver.folio}.xml`, '<?xml version="1.0" encoding="ISO-8859-1"?>\n' + ver.xml)}>XML</Boton>
              {['firmado', 'rechazado'].includes(ver.estado) && puede('admin', 'contador', 'operador') && (
                <Boton onClick={() => ejecutar(async () => `Reenviado. Track ID ${(await llamarFuncion('dte-estado', { empresaId: empresa.id, accion: 'reenviar', dteIds: [ver.id] })).trackId}`)} cargando={ocupado}>Enviar al SII</Boton>
              )}
              {!ver.asiento_id && ver.tipo !== 52 && ['aceptado', 'aceptado_reparos', 'enviado'].includes(ver.estado) && puede('admin', 'contador') && (
                <Boton onClick={() => ejecutar(async () => { await rpc('contabilizar_dte_emitido', { p_dte: ver.id }); return 'Documento contabilizado'; })}>Contabilizar</Boton>
              )}
              {[33, 34, 39].includes(ver.tipo) && ['aceptado', 'aceptado_reparos'].includes(ver.estado) && puede('admin', 'contador', 'operador') && (
                <Boton variante="secundario" onClick={() => nav(`/emitir?tipo=61&desde=${ver.id}&refTipo=${ver.tipo}&refFolio=${ver.folio}&refFecha=${ver.fecha_emision}`)}>Nota de crédito</Boton>
              )}
            </div>
            {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
            <Impreso dte={ver} empresa={empresa} />
          </>
        )}
      </Modal>
    </Pagina>
  );
}
