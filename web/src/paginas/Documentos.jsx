import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { TIPOS_DOC, csv, hoy, peso, rutFormato, rutValido } from '../util';

const vacio = { tipo: '33', folio: '', fecha: hoy(), rut: '', razon: '', neto: '', exento: '', ivaNR: '', cuenta: '', glosa: '' };

export default function Documentos() {
  const { empresa, puede } = useEmpresa();
  const [op, setOp] = useState('venta');
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [docs, setDocs] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [f, setF] = useState(vacio);
  const [abierto, setAbierto] = useState(false);
  const [msg, setMsg] = useState(null);
  const [anular, setAnular] = useState(null);
  const escribe = puede('admin', 'contador');

  const cargar = useCallback(async () => {
    const [a, m] = mes.split('-').map(Number);
    const fin = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
    setDocs(await q(sb.from('documentos').select('*').eq('empresa_id', empresa.id).eq('operacion', op)
      .gte('fecha', mes + '-01').lte('fecha', fin).order('fecha').order('folio')));
  }, [empresa.id, op, mes]);

  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);
  useEffect(() => {
    q(sb.from('cuentas').select('id, codigo, nombre, tipo').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true).order('codigo'))
      .then(setCuentas);
  }, [empresa.id]);

  const opciones = cuentas.filter((c) => (op === 'venta' ? c.tipo === 'ingreso' : ['gasto', 'activo'].includes(c.tipo)));
  const neto = Number(f.neto || 0), exento = Number(f.exento || 0);
  const iva = Math.round(neto * 0.19);
  const exentoTipo = ['34', '41'].includes(f.tipo);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function guardar(e) {
    e.preventDefault();
    setMsg(null);
    if (!rutValido(f.rut)) return setMsg({ ok: false, t: 'El RUT no es válido.' });
    try {
      await rpc('registrar_documento', {
        p_empresa: empresa.id, p_operacion: op, p_tipo: Number(f.tipo), p_folio: Number(f.folio), p_fecha: f.fecha,
        p_rut: f.rut, p_razon: f.razon, p_neto: exentoTipo ? 0 : neto, p_exento: exento,
        p_iva_no_recuperable: op === 'compra' ? Number(f.ivaNR || 0) : 0, p_cuenta: f.cuenta || null, p_glosa: f.glosa || null,
      });
      setMsg({ ok: true, t: 'Documento registrado y contabilizado.' });
      setF({ ...vacio, tipo: f.tipo, fecha: f.fecha });
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

  const exportar = () => csv(`libro_${op}s_${mes}`, docs.map((d) => ({
    Fecha: d.fecha, Tipo: d.tipo, Folio: d.folio, RUT: rutFormato(d.rut), 'Razón social': d.razon_social,
    Neto: d.neto, Exento: d.exento, IVA: d.iva, 'IVA no recup.': d.iva_no_recuperable, Total: d.total, Estado: d.estado,
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
          <label className="en-linea">Mes<input type="month" value={mes} onChange={(e) => setMes(e.target.value)} /></label>
          {escribe && <button className="primario" onClick={() => setAbierto(!abierto)}>{abierto ? 'Cerrar formulario' : '+ Registrar ' + op}</button>}
        </div>
      </header>

      {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'}>{msg.t}</p>}

      {abierto && escribe && (
        <form className="formulario rejilla" onSubmit={guardar}>
          <label>Tipo<select value={f.tipo} onChange={set('tipo')}>
            {Object.entries(TIPOS_DOC).filter(([t]) => op === 'compra' || t !== '46').map(([t, n]) => <option key={t} value={t}>{t} · {n}</option>)}
          </select></label>
          <label>Folio<input type="number" min="1" value={f.folio} onChange={set('folio')} required /></label>
          <label>Fecha<input type="date" max={hoy()} value={f.fecha} onChange={set('fecha')} required /></label>
          <label>RUT {op === 'venta' ? 'cliente' : 'proveedor'}
            <input value={f.rut} onChange={set('rut')} onBlur={() => setF({ ...f, rut: rutFormato(f.rut) })} placeholder={f.tipo === '39' ? '66.666.666-6' : ''} required
              aria-invalid={f.rut !== '' && !rutValido(f.rut)} />
          </label>
          <label className="ancho">Razón social<input value={f.razon} onChange={set('razon')} required maxLength={200} /></label>
          {!exentoTipo && <label>Neto afecto<input type="number" min="0" step="1" value={f.neto} onChange={set('neto')} /></label>}
          <label>Exento<input type="number" min="0" step="1" value={f.exento} onChange={set('exento')} /></label>
          {op === 'compra' && !exentoTipo && <label>IVA no recuperable<input type="number" min="0" max={iva} step="1" value={f.ivaNR} onChange={set('ivaNR')} /></label>}
          <label className="ancho">Cuenta de {op === 'venta' ? 'ingreso' : 'gasto o activo'} (opcional)
            <select value={f.cuenta} onChange={set('cuenta')}>
              <option value="">Por defecto de la empresa</option>
              {opciones.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
            </select>
          </label>
          <div className="resumen ancho">
            <span>IVA 19 %: <b>{peso(exentoTipo ? 0 : iva)}</b></span>
            <span>Total: <b>{peso((exentoTipo ? 0 : neto + iva) + exento)}</b></span>
          </div>
          <div className="acciones ancho"><button className="primario">Registrar y contabilizar</button></div>
        </form>
      )}

      <div className="scroll">
        <table className="tabla">
          <thead><tr><th>Fecha</th><th>Tipo</th><th className="n">Folio</th><th>RUT</th><th>Razón social</th><th className="n">Neto</th><th className="n">Exento</th><th className="n">IVA</th><th className="n">Total</th><th></th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={10} className="vacio">No hay documentos en este mes.</td></tr>}
            {docs.map((d) => (
              <tr key={d.id} className={d.estado === 'anulado' ? 'anulado' : ''}>
                <td className="nw">{d.fecha}</td><td title={TIPOS_DOC[d.tipo]}>{d.tipo}</td><td className="n">{d.folio}</td>
                <td className="nw">{rutFormato(d.rut)}</td><td>{d.razon_social}</td>
                <td className="n">{peso(d.neto)}</td><td className="n">{peso(d.exento)}</td><td className="n">{peso(d.iva)}</td><td className="n">{peso(d.total)}</td>
                <td>{d.estado === 'anulado' ? <span className="etiqueta" title={d.motivo_anulacion}>Anulado</span>
                  : escribe && <button className="enlace" onClick={() => setAnular({ id: d.id, folio: d.folio, motivo: '' })}>Anular</button>}</td>
              </tr>
            ))}
          </tbody>
          {docs.length > 0 && (
            <tfoot><tr><td colSpan={5}>Totales vigentes (notas de crédito restan)</td>
              <td className="n">{peso(tot.neto)}</td><td className="n">{peso(tot.exento)}</td><td className="n">{peso(tot.iva)}</td><td className="n">{peso(tot.total)}</td><td></td></tr></tfoot>
          )}
        </table>
      </div>
      {docs.length > 0 && <button onClick={exportar}>Descargar CSV</button>}

      {anular && (
        <div className="velo" role="dialog" aria-modal="true">
          <form className="dialogo" onSubmit={confirmarAnulacion}>
            <h2>Anular folio {anular.folio}</h2>
            <p>Se anulará el asiento (o se reversará si el período está cerrado). Queda registrado en la auditoría.</p>
            <label>Motivo<input value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} minLength={5} required autoFocus /></label>
            {anular.error && <p className="aviso error">{anular.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAnular(null)}>Cancelar</button><button className="peligro">Anular documento</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
