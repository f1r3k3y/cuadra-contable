// Registro de Compras y Ventas (RCV) y propuesta de Formulario 29.
import { useState } from 'react';
import { supabase, llamarFuncion, rpc } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { pesos, fecha, leerArchivo, csv, periodoActual, NOMBRE_DTE } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Aviso, Vacio, Cargando, Estado, useCarga } from '../components/ui';
import { calcularF29, type EntradaF29 } from '../../../supabase/functions/_shared/sii/f29.ts';

const MOTIVO: Record<string, string> = { solo_en_sii: 'Está en el SII, no en la contabilidad', solo_en_libro: 'Está en la contabilidad, no en el SII', monto_distinto: 'Montos distintos' };

function SelectorPeriodo({ periodo, setPeriodo }: { periodo: string; setPeriodo: (p: string) => void }) {
  return <Campo etiqueta="Período"><Entrada type="month" value={`${periodo.slice(0, 4)}-${periodo.slice(4)}`} onChange={(e) => setPeriodo(e.target.value.replace('-', ''))} /></Campo>;
}

export function Rcv() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const [periodo, setPeriodo] = useState(periodoActual());
  const [operacion, setOperacion] = useState<'COMPRA' | 'VENTA'>('COMPRA');
  const [diferencias, setDiferencias] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const { datos, cargando, recargar } = useCarga(async () => {
    const { data, error } = await supabase.from('rcv_registros').select('*').eq('empresa_id', empresa.id).eq('periodo', periodo).eq('operacion', operacion).order('fecha_emision');
    if (error) throw new Error(error.message);
    return data;
  }, [empresa.id, periodo, operacion]);

  async function sincronizar(csvTexto?: string) {
    setMsg(null);
    setOcupado(true);
    try {
      const r = await llamarFuncion('rcv-sync', { empresaId: empresa.id, periodo, operacion, csv: csvTexto });
      setDiferencias(r.diferencias);
      setMsg({ tipo: 'ok', txt: `${r.importados} registro(s) ${r.fuente === 'sii' ? 'desde el SII' : 'desde el CSV'}. ${r.diferencias.length} diferencia(s) con la contabilidad.` });
      recargar();
    } catch (e) {
      setMsg({ tipo: 'error', txt: (e as Error).message });
    } finally {
      setOcupado(false);
    }
  }

  const tot = (k: string) => (datos ?? []).filter((r: any) => r.estado === 'REGISTRO').reduce((s: number, r: any) => s + (r.tipo === 61 ? -1 : 1) * Number(r[k]), 0);

  return (
    <Pagina titulo="Registro de Compras y Ventas" sub="Cuadratura entre lo que el SII registra y lo contabilizado."
      acciones={puede('admin', 'contador') && <>
        <label className="btn btn-secundario">Importar CSV del SII<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) sincronizar(await leerArchivo(f, 'latin1')); e.target.value = ''; }} /></label>
        <Boton onClick={() => sincronizar()} cargando={ocupado} disabled={empresa.sii_ambiente !== 'produccion'} title={empresa.sii_ambiente !== 'produccion' ? 'Disponible en producción' : ''}>Sincronizar con el SII</Boton>
      </>}>
      <div className="filtros">
        <SelectorPeriodo periodo={periodo} setPeriodo={setPeriodo} />
        <Campo etiqueta="Registro"><Selector value={operacion} onChange={(e) => setOperacion(e.target.value as 'COMPRA')}><option value="COMPRA">Compras</option><option value="VENTA">Ventas</option></Selector></Campo>
      </div>
      {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
      {diferencias && (
        <Tarjeta titulo={`Diferencias (${diferencias.length})`}>
          {!diferencias.length ? <p className="ok-txt">✓ El RCV cuadra con la contabilidad.</p> : (
            <table className="tabla compacta">
              <thead><tr><th>Documento</th><th>RUT</th><th>Motivo</th><th className="num">SII</th><th className="num">Contabilidad</th></tr></thead>
              <tbody>{diferencias.map((d) => (
                <tr key={d.clave}><td>{NOMBRE_DTE[d.tipo] ?? d.tipo} N° {d.folio}</td><td className="mono">{d.rutContraparte}</td><td>{MOTIVO[d.motivo]}</td><td className="num">{d.enRcv ? pesos(d.enRcv.total) : '—'}</td><td className="num">{d.enLibro ? pesos(d.enLibro.total) : '—'}</td></tr>
              ))}</tbody>
            </table>
          )}
        </Tarjeta>
      )}
      <Tarjeta titulo="Registros" extra={<button className="enlace" onClick={() => csv(`rcv_${operacion}_${periodo}.csv`, datos ?? [])}>CSV</button>}>
        {cargando ? <Cargando /> : !datos?.length ? <Vacio>Sin registros para el período. {empresa.sii_ambiente !== 'produccion' && 'En certificación, importe el CSV descargado desde sii.cl.'}</Vacio> : (
          <table className="tabla compacta">
            <thead><tr><th>Fecha</th><th>Documento</th><th>Contraparte</th><th>Estado</th><th className="num">Neto</th><th className="num">IVA</th><th className="num">Total</th></tr></thead>
            <tbody>{datos.map((r: any) => (
              <tr key={r.id}><td>{fecha(r.fecha_emision)}</td><td>{NOMBRE_DTE[r.tipo] ?? r.tipo} <span className="mono">{r.folio}</span></td><td>{r.razon_social}<div className="sub mono pequeno">{r.rut_contraparte}</div></td><td className="sub">{r.estado}</td><td className="num">{pesos(r.neto)}</td><td className="num">{pesos(r.iva)}</td><td className="num">{pesos(r.total)}</td></tr>
            ))}</tbody>
            <tfoot><tr className="total"><td colSpan={4}>Totales registrados</td><td className="num">{pesos(tot('neto'))}</td><td className="num">{pesos(tot('iva'))}</td><td className="num">{pesos(tot('total'))}</td></tr></tfoot>
          </table>
        )}
      </Tarjeta>
    </Pagina>
  );
}

export function F29() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const [periodo, setPeriodo] = useState(periodoActual());
  const [retencion, setRetencion] = useState('0');
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);

  const { datos, cargando, error } = useCarga(async () => {
    const resumen = await rpc<any>('resumen_iva', { p_empresa: empresa.id, p_periodo: periodo });
    const { data: guardado } = await supabase.from('f29_declaraciones').select('*').eq('empresa_id', empresa.id).eq('periodo', periodo).maybeSingle();
    return { resumen, guardado };
  }, [empresa.id, periodo]);

  const entrada: EntradaF29 | null = datos ? {
    ventas: datos.resumen.ventas, compras: datos.resumen.compras,
    remanenteAnterior: Number(datos.resumen.remanenteAnterior ?? 0), tasaPpm: Number(datos.resumen.tasaPpm ?? 0),
    retencionHonorarios: Number(retencion) || 0,
  } : null;
  const calc = entrada ? calcularF29(entrada) : null;

  async function guardar(estado: 'borrador' | 'presentado') {
    if (!calc) return;
    setMsg(null);
    const { error } = await supabase.from('f29_declaraciones').upsert({
      empresa_id: empresa.id, periodo, lineas: calc.lineas, iva_determinado: calc.ivaDeterminado,
      remanente_siguiente: calc.remanenteSiguiente, total_pagar: calc.totalAPagar, estado,
    }, { onConflict: 'empresa_id,periodo' });
    setMsg(error ? { tipo: 'error', txt: error.message } : { tipo: 'ok', txt: estado === 'presentado' ? 'Marcado como presentado. El remanente pasa al período siguiente.' : 'Propuesta guardada.' });
  }

  return (
    <Pagina titulo="Formulario 29" sub="Propuesta de declaración mensual de IVA y PPM calculada desde los libros. Compárela con la propuesta del SII antes de declarar en sii.cl.">
      <div className="filtros">
        <SelectorPeriodo periodo={periodo} setPeriodo={setPeriodo} />
        <Campo etiqueta="Retención de honorarios (cód. 151)"><Entrada inputMode="numeric" value={retencion} onChange={(e) => setRetencion(e.target.value.replace(/\D/g, ''))} /></Campo>
      </div>
      <Aviso tipo="error">{error}</Aviso>
      {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
      {cargando ? <Cargando /> : calc && datos && (
        <div className="grid-3">
          <Tarjeta titulo="Códigos del formulario" className="span-2">
            <table className="tabla compacta">
              <thead><tr><th>Código</th><th>Concepto</th><th className="num">Valor</th></tr></thead>
              <tbody>
                {calc.lineas.map((l) => (
                  <tr key={l.codigo} className={[538, 537, 89, 91].includes(l.codigo) ? 'total' : ''}>
                    <td className="mono">[{l.codigo}]</td><td>{l.glosa}</td>
                    <td className="num">{l.codigo === 115 ? `${l.valor}%` : [503, 110, 512, 509, 519, 531, 527].includes(l.codigo) ? l.valor : pesos(l.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Tarjeta>
          <Tarjeta titulo="Resumen">
            <dl className="ratios grande">
              <dt>IVA determinado</dt><dd>{pesos(calc.ivaDeterminado)}</dd>
              <dt>Remanente para el mes siguiente</dt><dd>{pesos(calc.remanenteSiguiente)}</dd>
              <dt className="fuerte">Total a pagar</dt><dd className="fuerte">{pesos(calc.totalAPagar)}</dd>
            </dl>
            <p className="sub pequeno">Compras tomadas de: {datos.resumen.fuenteCompras === 'rcv' ? 'Registro de Compras (SII)' : 'documentos recibidos'}. Tasa PPM {datos.resumen.tasaPpm}% (configurable).</p>
            {datos.guardado && <p>Estado guardado: <Estado valor={datos.guardado.estado === 'presentado' ? 'aceptado' : 'borrador'} /> {datos.guardado.estado}</p>}
            {puede('admin', 'contador') && (
              <div className="acciones">
                <Boton variante="secundario" onClick={() => guardar('borrador')}>Guardar propuesta</Boton>
                <Boton onClick={() => guardar('presentado')}>Marcar como presentado</Boton>
              </div>
            )}
          </Tarjeta>
        </div>
      )}
    </Pagina>
  );
}
