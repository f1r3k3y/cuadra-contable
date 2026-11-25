import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { TIPOS_DOC, csv, fecha, hoy, peso, rutFormato, rutValido } from '../util';
import { Aviso, CampoMonto, Dialogo, SelectorMes } from '../componentes';

const vacio = { tipo: '33', folio: '', fecha: hoy(), rut: '', razon: '', neto: '', exento: '', ivaNR: '', cuenta: '', glosa: '', referencia: '', condicion: '0', vencimiento: '', totalBoleta: '' };
const CONDICIONES = [['0', 'Contado'], ['30', '30 días'], ['45', '45 días'], ['60', '60 días'], ['90', '90 días'], ['otra', 'Otra fecha']];
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export default function Documentos() {
  const { empresa, permite } = useEmpresa();
  const [op, setOp] = useState('venta');
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [docs, setDocs] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [f, setF] = useState(vacio);
  const [abierto, setAbierto] = useState(false);
  const [msg, setMsg] = useState(null);
  const [anular, setAnular] = useState(null);
  const [referibles, setReferibles] = useState([]);
  const escribe = permite('documentos.registrar');
  const anula = permite('documentos.anular');
  const aprueba = permite('asientos.contabilizar');

  const cargar = useCallback(async () => {
    const [a, m] = mes.split('-').map(Number);
    const fin = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
    setDocs(await q(sb.from('documentos_saldo').select('*').eq('empresa_id', empresa.id).eq('operacion', op)
      .gte('fecha', mes + '-01').lte('fecha', fin).order('fecha').order('folio')));
  }, [empresa.id, op, mes]);

  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);
  const [excluidas, setExcluidas] = useState(new Set());
  useEffect(() => {
    q(sb.from('cuentas').select('id, codigo, nombre, tipo, clasificacion, es_efectivo, padre_id').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true).order('codigo'))
      .then(setCuentas);
    // Grupos que no son gasto ni activo comprable: clientes, impuestos por recuperar (IVA, PPM)
    q(sb.from('configuracion_cuentas').select('cuenta_clientes, cuenta_iva_credito, cuenta_ppm').eq('empresa_id', empresa.id).maybeSingle())
      .then((c) => setExcluidas(new Set(c ? Object.values(c).filter(Boolean) : []))).catch(() => {});
  }, [empresa.id]);

  const esNota = ['56', '61'].includes(f.tipo);
  useEffect(() => {
    if (!abierto || !esNota) return;
    let consulta = sb.from('documentos_saldo').select('id, tipo, folio, fecha, rut, razon_social, total, saldo')
      .eq('empresa_id', empresa.id).eq('operacion', op).eq('estado', 'vigente').neq('tipo', 61);
    if (f.tipo === '61') consulta = consulta.gt('saldo', 0);
    q(consulta.order('fecha', { ascending: false }).limit(300)).then(setReferibles).catch(() => setReferibles([]));
  }, [abierto, esNota, f.tipo, op, empresa.id]);
  const refElegida = referibles.find((r) => r.id === f.referencia);
  const elegirReferencia = (e) => {
    const r = referibles.find((x) => x.id === e.target.value);
    setF({ ...f, referencia: e.target.value, ...(r ? { rut: rutFormato(r.rut), razon: r.razon_social } : {}) });
  };
  const vencimiento = f.tipo === '61' ? null
    : f.condicion === 'otra' ? (f.vencimiento || null)
    : f.condicion === '0' ? null : sumarDias(f.fecha, Number(f.condicion));

  const padresExcluidos = new Set(cuentas.filter((c) => excluidas.has(c.id)).map((c) => c.padre_id).filter(Boolean));
  const opciones = cuentas.filter((c) => (op === 'venta' ? c.tipo === 'ingreso'
    : c.tipo === 'gasto' || (c.tipo === 'activo' && !c.es_efectivo && !excluidas.has(c.id) && !padresExcluidos.has(c.padre_id) && !/acumulad/i.test(c.nombre))));
  const esBoleta = f.tipo === '39';
  const neto = esBoleta ? Math.round(Number(f.totalBoleta || 0) / 1.19) : Number(f.neto || 0), exento = Number(f.exento || 0);
  const iva = Math.round(neto * 0.19);
  const exentoTipo = ['34', '41'].includes(f.tipo);
  // Venta con boleta sin datos del comprador: consumidor final (RUT genérico del SII)
  const consumidorFinal = op === 'venta' && ['39', '41'].includes(f.tipo);
  const boletaRecibida = op === 'compra' && esBoleta;
  const set = (k) => (e) => { if (msg?.ok) setMsg(null); setF({ ...f, [k]: e.target.value }); };

  async function guardar(e) {
    e.preventDefault();
    setMsg(null);
    const rut = consumidorFinal && !f.rut.trim() ? '66.666.666-6' : f.rut;
    const razon = consumidorFinal && !f.razon.trim() ? 'Consumidor final' : f.razon;
    if (!rutValido(rut)) return setMsg({ ok: false, t: 'El RUT no es válido.' });
    if (f.tipo === '61' && !f.referencia) return setMsg({ ok: false, t: 'Elige la factura o boleta que rebaja la nota de crédito.' });
    try {
      await rpc('registrar_documento', {
        p_empresa: empresa.id, p_operacion: op, p_tipo: Number(f.tipo), p_folio: Number(f.folio), p_fecha: f.fecha,
        p_rut: rut, p_razon: razon, p_neto: exentoTipo ? 0 : neto, p_exento: exento,
        p_iva_no_recuperable: op === 'compra' ? Number(f.ivaNR || 0) : 0, p_cuenta: f.cuenta || null, p_glosa: f.glosa || null,
        p_referencia: esNota && f.referencia ? f.referencia : null, p_vencimiento: vencimiento,
      });
      setMsg({ ok: true, t: aprueba ? 'Documento registrado y contabilizado.' : 'Documento registrado. Queda por aprobar del contador antes de afectar los libros.' });
      setF({ ...vacio, tipo: f.tipo, fecha: f.fecha, condicion: f.condicion });
      if (f.fecha.slice(0, 7) !== mes) setMes(f.fecha.slice(0, 7)); else cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function confirmarAnulacion(e) {
    e.preventDefault();
    try {
      await rpc('anular_documento', { p_id: anular.id, p_motivo: anular.motivo });
      setAnular(null);
      setMsg({ ok: true, t: 'Documento anulado; su asiento fue anulado o reversado.' });
      cargar();
    } catch (err) { setAnular({ ...anular, error: err.message }); }
  }

  const tot = useMemo(() => docs.filter((d) => d.estado === 'vigente').reduce((s, d) => {
    const sg = d.tipo === 61 ? -1 : 1;
    s.neto += sg * d.neto; s.exento += sg * d.exento; s.iva += sg * d.iva; s.total += sg * d.total; return s;
  }, { neto: 0, exento: 0, iva: 0, total: 0 }), [docs]);

  const vencido = (d) => d.estado === 'vigente' && d.tipo !== 61 && Number(d.saldo) > 0 && d.asiento_estado === 'contabilizado' && d.vence < hoy();
  const refTexto = (id) => { const r = docs.find((x) => x.id === id) || referibles.find((x) => x.id === id); return r ? `folio ${r.folio} (tipo ${r.tipo})` : 'documento de otro mes'; };

  const exportar = () => csv(`libro_${op}s_${mes}`, docs.map((d) => ({
    Fecha: fecha(d.fecha), Tipo: d.tipo, Folio: d.folio, RUT: rutFormato(d.rut), 'Razón social': d.razon_social,
    Neto: d.neto, Exento: d.exento, IVA: d.iva, 'IVA no recup.': d.iva_no_recuperable, Total: d.total, Saldo: d.tipo === 61 ? '' : d.saldo, Vencimiento: d.vencimiento ? fecha(d.vencimiento) : '', Estado: d.estado,
  })));

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Libro de {op === 'venta' ? 'ventas' : 'compras'}</h1>
          <p className="chico">Cada documento genera su asiento contable automáticamente (IVA 19 %).</p>
        </div>
        <div className="filtros">
          <div className="pestanas">
            <button className={op === 'venta' ? 'activa' : ''} onClick={() => setOp('venta')}>Ventas</button>
            <button className={op === 'compra' ? 'activa' : ''} onClick={() => setOp('compra')}>Compras</button>
          </div>
          <SelectorMes valor={mes} alCambiar={setMes} />
          {escribe && <button className="primario" onClick={() => setAbierto(!abierto)}>{abierto ? 'Cerrar formulario' : '+ Registrar ' + op}</button>}
        </div>
      </header>

      <Aviso msg={msg} />

      {abierto && escribe && (
        <form className="formulario rejilla" onSubmit={guardar}>
          <label>Tipo<select value={f.tipo} onChange={set('tipo')}>
            {Object.entries(TIPOS_DOC).filter(([t]) => op === 'compra' || t !== '46').map(([t, n]) => <option key={t} value={t}>{t} · {n}</option>)}
          </select></label>
          {esNota && (
            <label className="ancho">Documento que modifica{f.tipo === '61' ? '' : ' (opcional)'}
              <select value={f.referencia} onChange={elegirReferencia} required={f.tipo === '61'}>
                <option value="">{referibles.length ? 'Elige el documento…' : f.tipo === '61' ? 'No hay documentos con saldo pendiente' : 'Sin referencia'}</option>
                {referibles.map((r) => <option key={r.id} value={r.id}>{r.tipo} N° {r.folio} · {fecha(r.fecha)} · {r.razon_social} · saldo {peso(r.saldo)}</option>)}
              </select>
            </label>
          )}
          <label>Folio<input type="number" min="1" value={f.folio} onChange={set('folio')} required /></label>
          <label>Fecha<input type="date" max={hoy()} value={f.fecha} onChange={set('fecha')} required /></label>
          {f.tipo !== '61' && (
            <label>Condición de pago<select value={f.condicion} onChange={set('condicion')}>
              {CONDICIONES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select></label>
          )}
          {f.tipo !== '61' && f.condicion === 'otra' && (
            <label>Vencimiento<input type="date" min={f.fecha} value={f.vencimiento} onChange={set('vencimiento')} required /></label>
          )}
          <label>RUT {op === 'venta' ? 'cliente' : 'proveedor'}
            <input value={f.rut} onChange={set('rut')} onBlur={() => setF({ ...f, rut: rutFormato(f.rut) })} placeholder={consumidorFinal ? '66.666.666-6 (consumidor final)' : ''} required={!consumidorFinal}
              aria-invalid={f.rut !== '' && !rutValido(f.rut)} />
          </label>
          <label className="ancho">Razón social<input value={f.razon} onChange={set('razon')} required={!consumidorFinal} placeholder={consumidorFinal ? 'Consumidor final' : ''} maxLength={200} /></label>
          {esBoleta && <label>Total de la boleta (IVA incluido)<CampoMonto valor={f.totalBoleta ?? ''} alCambiar={(v) => setF({ ...f, totalBoleta: v })} /></label>}
          {!exentoTipo && !esBoleta && <label>Neto afecto<CampoMonto valor={f.neto} alCambiar={(v) => setF({ ...f, neto: v })} /></label>}
          <label>Exento<CampoMonto valor={f.exento} alCambiar={(v) => setF({ ...f, exento: v })} /></label>
          {boletaRecibida && <p className="chico ancho">Una boleta recibida no da derecho a crédito fiscal: todo su IVA se registra como gasto.</p>}
          {op === 'compra' && !exentoTipo && !boletaRecibida && <label>IVA no recuperable<CampoMonto valor={f.ivaNR} max={iva} alCambiar={(v) => setF({ ...f, ivaNR: v })} /></label>}
          <label className="ancho">Cuenta de {op === 'venta' ? 'ingreso' : 'gasto o activo'} (opcional)
            <select value={f.cuenta} onChange={set('cuenta')}>
              <option value="">Por defecto de la empresa</option>
              {opciones.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
            </select>
          </label>
          <div className="resumen ancho">
            {esBoleta && neto > 0 && <span>Neto: <b>{peso(neto)}</b></span>}
            <span>IVA 19 %: <b>{peso(exentoTipo ? 0 : iva)}</b></span>
            <span>Total: <b>{peso((exentoTipo ? 0 : neto + iva) + exento)}</b></span>
            {vencimiento && <span>Vence: <b>{fecha(vencimiento)}</b></span>}
            {f.tipo === '61' && refElegida && <span>Saldo del documento después de la nota: <b>{peso(Number(refElegida.saldo) - ((exentoTipo ? 0 : neto + iva) + exento))}</b></span>}
          </div>
          <div className="acciones ancho"><button className="primario">{aprueba ? 'Registrar y contabilizar' : 'Registrar (queda por aprobar)'}</button></div>
        </form>
      )}

      <div className="scroll">
        <table className="tabla">
          <thead><tr><th>Fecha</th><th>Tipo</th><th className="n">Folio</th><th>RUT</th><th>Razón social</th><th className="n">Neto</th><th className="n">Exento</th><th className="n">IVA</th><th className="n">Total</th><th className="n">Saldo</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={13} className="vacio">No hay documentos en este mes.</td></tr>}
            {docs.map((d) => (
              <tr key={d.id} className={d.estado === 'anulado' ? 'anulado' : ''}>
                <td className="nw">{fecha(d.fecha)}</td><td title={TIPOS_DOC[d.tipo] + (d.referencia_id ? ` que modifica el ${refTexto(d.referencia_id)}` : '')}>{d.tipo}</td><td className="n">{d.folio}</td>
                <td className="nw">{rutFormato(d.rut)}</td><td>{d.razon_social}</td>
                <td className="n">{peso(d.neto)}</td><td className="n">{peso(d.exento)}</td><td className="n">{peso(d.iva)}</td><td className="n">{peso(d.total)}</td>
                <td className="n" title={Number(d.notas_credito) > 0 ? `Rebajado por notas de crédito: ${peso(d.notas_credito)}` : undefined}>{d.estado === 'vigente' && d.tipo !== 61 ? peso(d.saldo) : ''}</td>
                <td className={'nw' + (vencido(d) ? ' texto-vencido' : '')}>{d.tipo !== 61 && d.vencimiento ? fecha(d.vencimiento) : ''}</td>
                <td>{d.estado === 'anulado' ? <span className="etiqueta anulado" title={d.motivo_anulacion}>Anulado</span>
                  : d.asiento_estado === 'borrador' ? <span className="etiqueta borrador">Por aprobar</span>
                  : d.tipo !== 61 && Number(d.saldo) === 0 ? <span className="etiqueta contabilizado">{op === 'venta' ? 'Cobrado' : 'Pagado'}</span>
                  : vencido(d) ? <span className="etiqueta vencida">Vencido</span>
                  : <span className="etiqueta">Vigente</span>}</td>
                <td>{d.estado === 'vigente' && anula && <button className="enlace" onClick={() => setAnular({ id: d.id, folio: d.folio, motivo: '' })}>Anular</button>}</td>
              </tr>
            ))}
          </tbody>
          {docs.length > 0 && (
            <tfoot><tr><td colSpan={5}>Totales vigentes (notas de crédito restan)</td>
              <td className="n">{peso(tot.neto)}</td><td className="n">{peso(tot.exento)}</td><td className="n">{peso(tot.iva)}</td><td className="n">{peso(tot.total)}</td><td colSpan={4}></td></tr></tfoot>
          )}
        </table>
      </div>
      {docs.length > 0 && <button onClick={exportar}>Descargar CSV</button>}

      {anular && (
        <Dialogo titulo={`Anular folio ${anular.folio}`} alCerrar={() => setAnular(null)}>
          <form onSubmit={confirmarAnulacion}>
            <h2>Anular folio {anular.folio}</h2>
            <p>Se anulará el asiento (o se reversará si el período está cerrado). Queda registrado en la auditoría.</p>
            <label>Motivo<input value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} minLength={5} required autoFocus /></label>
            {anular.error && <p className="aviso error">{anular.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAnular(null)}>Cancelar</button><button className="peligro">Anular documento</button></div>
          </form>
        </Dialogo>
      )}
    </section>
  );
}
