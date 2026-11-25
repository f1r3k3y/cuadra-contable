import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { csv, docCorto, fecha, hoy, peso, rutFormato, rutValido } from '../util';
import { Aviso, CampoMonto, Dialogo, SelectorMes } from '../componentes';

const vacio = () => ({ tipo: '900', folio: '', fecha: hoy(), rut: '', nombre: '', bruto: '', retiene: true, cuenta: '', glosa: '', plazo: '0' });

export default function Honorarios() {
  const { empresa, permite } = useEmpresa();
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [docs, setDocs] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [f, setF] = useState(null);
  const [anular, setAnular] = useState(null);
  const [msg, setMsg] = useState(null);
  const registra = permite('honorarios.registrar');

  async function resumenAnual() {
    try {
      const anio = Number(mes.slice(0, 4));
      const r = await rpc('resumen_anual_retenciones', { p_empresa: empresa.id, p_anio: anio });
      if (!r.honorarios?.length) return setMsg({ ok: false, t: `No hay boletas de honorarios en ${anio}.` });
      const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      csv(`dj1879_base_${anio}`, r.honorarios.map((h) => ({ RUT: rutFormato(h.rut), Nombre: h.nombre, Boletas: h.boletas, MontoBruto: h.bruto, Retencion: h.retencion,
        ...Object.fromEntries(MES.map((m, i) => ['Ret' + m, h.meses[i]])) })));
    } catch (e) { setMsg({ ok: false, t: e.message }); }
  }

  const cargar = useCallback(async () => {
    const [a, m] = mes.split('-');
    const fin = new Date(Number(a), Number(m), 0).getDate();
    setDocs(await q(sb.from('documentos_saldo').select('*').eq('empresa_id', empresa.id).eq('operacion', 'honorario')
      .gte('fecha', `${mes}-01`).lte('fecha', `${mes}-${fin}`).order('fecha').order('folio')));
  }, [empresa.id, mes]);
  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);
  useEffect(() => {
    if (registra) q(sb.from('cuentas').select('id, codigo, nombre').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true)
      .eq('tipo', 'gasto').order('codigo')).then(setCuentas).catch(() => {});
  }, [empresa.id, registra]);

  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const tasa = f ? retencionPara(f.fecha) : 0;
  const ret = f && f.retiene ? Math.round(Number(f.bruto || 0) * tasa / 100) : 0;

  async function guardar(e) {
    e.preventDefault();
    if (!rutValido(f.rut)) return setF({ ...f, error: 'El RUT del prestador no es válido.' });
    try {
      const venc = Number(f.plazo) > 0 ? new Date(new Date(f.fecha).getTime() + Number(f.plazo) * 86400000).toISOString().slice(0, 10) : null;
      const d = await rpc('registrar_honorario', {
        p_empresa: empresa.id, p_folio: Number(f.folio), p_fecha: f.fecha, p_rut: f.rut, p_nombre: f.nombre, p_bruto: Number(f.bruto),
        p_retiene: f.retiene, p_tipo: Number(f.tipo), p_cuenta: f.cuenta || null, p_glosa: f.glosa || null, p_vencimiento: venc,
      });
      setMsg({ ok: true, t: `Boleta registrada: retención ${peso(d.retencion)}, líquido a pagar ${peso(d.total - d.retencion)}.` + (permite('asientos.contabilizar') ? '' : ' Queda por aprobar del contador.') });
      setF(null);
      setMes(d.fecha.slice(0, 7));
      cargar();
    } catch (err) { setF({ ...f, error: err.message }); }
  }

  async function confirmarAnulacion(e) {
    e.preventDefault();
    try { await rpc('anular_documento', { p_id: anular.id, p_motivo: anular.motivo }); setAnular(null); setMsg({ ok: true, t: 'Boleta anulada.' }); cargar(); }
    catch (err) { setAnular({ ...anular, error: err.message }); }
  }

  const vig = docs.filter((d) => d.estado === 'vigente');
  const tot = (k) => vig.reduce((s, d) => s + Number(d[k]), 0);

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Boletas de honorarios</h1>
          <p className="chico">Boletas recibidas de personas que prestan servicios. La retención va al F29 (código 151) y el líquido se paga en Tesorería.</p>
        </div>
        <div className="filtros">
          <SelectorMes valor={mes} alCambiar={setMes} />
          {registra && !f && <button className="primario" onClick={() => setF(vacio())}>+ Registrar boleta</button>}
          <button onClick={resumenAnual} title="Retenciones por prestador y mes del año: base para la Declaración Jurada 1879">Resumen anual {mes.slice(0, 4)} (DJ 1879)</button>
        </div>
      </header>
      <Aviso msg={msg} />

      {f && (
        <form className="formulario rejilla" onSubmit={guardar}>
          <label>Tipo<select value={f.tipo} onChange={set('tipo')}>
            <option value="900">Boleta de honorarios electrónica (BHE)</option>
            <option value="901">Boleta de prestación de servicios de terceros (BTE)</option>
          </select></label>
          <label>N° de boleta<input inputMode="numeric" value={f.folio} onChange={(e) => setF({ ...f, folio: e.target.value.replace(/\D/g, '') })} required /></label>
          <label>Fecha<input type="date" max={hoy()} value={f.fecha} onChange={set('fecha')} required /></label>
          <label>RUT del prestador<input value={f.rut} onChange={set('rut')} onBlur={() => setF({ ...f, rut: rutFormato(f.rut) })} placeholder="12.345.678-5" required /></label>
          <label className="ancho">Nombre<input value={f.nombre} onChange={set('nombre')} required maxLength={200} /></label>
          <label>Monto bruto (total honorarios)<CampoMonto valor={f.bruto} alCambiar={set('bruto')} required /></label>
          <label className="check" data-ayuda="Las empresas que llevan contabilidad deben retener. Desmarque solo si la boleta dice que la retención la paga el propio prestador.">
            <input type="checkbox" checked={f.retiene} onChange={set('retiene')} /> La empresa retiene ({String(tasa).replace('.', ',')} %)
          </label>
          <label>Plazo de pago<select value={f.plazo} onChange={set('plazo')}>
            <option value="0">Contado</option><option value="15">15 días</option><option value="30">30 días</option>
          </select></label>
          <label className="ancho">Cuenta de gasto (opcional)<select value={f.cuenta} onChange={set('cuenta')}>
            <option value="">Honorarios (por defecto)</option>
            {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
          </select></label>
          <label className="ancho">Glosa (opcional)<input value={f.glosa} onChange={set('glosa')} maxLength={300} placeholder="Ej.: asesoría legal de noviembre" /></label>
          <p className="ancho chico">Retención: <b>{peso(ret)}</b> · Líquido a pagar: <b>{peso(Number(f.bruto || 0) - ret)}</b></p>
          {f.error && <p className="aviso error ancho">{f.error}</p>}
          <div className="acciones ancho">
            <button type="button" onClick={() => setF(null)}>Cancelar</button>
            <button className="primario">{permite('asientos.contabilizar') ? 'Registrar y contabilizar' : 'Registrar (queda por aprobar)'}</button>
          </div>
        </form>
      )}

      <div className="scroll">
        <table className="tabla">
          <thead><tr><th>Fecha</th><th>Boleta</th><th>Prestador</th><th className="n">Bruto</th><th className="n">Retención</th><th className="n">Líquido</th><th className="n">Saldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={9} className="vacio">No hay boletas en el mes.</td></tr>}
            {docs.map((d) => (
              <tr key={d.id} className={d.estado === 'anulado' ? 'anulado' : ''}>
                <td className="nw">{fecha(d.fecha)}</td><td className="nw">{docCorto(d.tipo, d.folio)}</td>
                <td>{d.razon_social}<small> · {rutFormato(d.rut)}</small></td>
                <td className="n">{peso(d.total)}</td>
                <td className="n" title={d.tasa_retencion ? `${d.tasa_retencion} %` : 'Sin retención'}>{peso(d.retencion)}</td>
                <td className="n">{peso(d.total - d.retencion)}</td>
                <td className="n">{d.estado === 'vigente' ? peso(d.saldo) : ''}</td>
                <td>{d.estado === 'anulado' ? <span className="etiqueta anulado" title={d.motivo_anulacion}>Anulada</span>
                  : d.asiento_estado === 'contabilizado' ? <span className="etiqueta contabilizado">Vigente</span> : <span className="etiqueta borrador">Por aprobar</span>}</td>
                <td>{d.estado === 'vigente' && permite('documentos.anular') && <button className="enlace" onClick={() => setAnular({ id: d.id, motivo: '' })}>Anular</button>}</td>
              </tr>
            ))}
          </tbody>
          {vig.length > 0 && <tfoot><tr><td colSpan={3}>Totales vigentes</td><td className="n">{peso(tot('total'))}</td><td className="n">{peso(tot('retencion'))}</td><td className="n">{peso(tot('total') - tot('retencion'))}</td><td className="n">{peso(tot('saldo'))}</td><td colSpan={2}></td></tr></tfoot>}
        </table>
      </div>
      {docs.length > 0 && <button onClick={() => csv(`honorarios_${mes}`, docs.map((d) => ({ Fecha: fecha(d.fecha), Tipo: d.tipo === 900 ? 'BHE' : 'BTE', Numero: d.folio, RUT: rutFormato(d.rut), Nombre: d.razon_social, Bruto: d.total, Retencion: d.retencion, Liquido: d.total - d.retencion, Estado: d.estado })))}>Descargar CSV</button>}

      {anular && (
        <Dialogo titulo="Anular boleta" alCerrar={() => setAnular(null)}>
          <form onSubmit={confirmarAnulacion}>
            <h2>Anular boleta de honorarios</h2>
            <p>Se anula (o reversa) su asiento y deja de contar en la retención del F29.</p>
            <label>Motivo<input value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} minLength={5} required autoFocus /></label>
            {anular.error && <p className="aviso error">{anular.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAnular(null)}>Cancelar</button><button className="peligro">Anular</button></div>
          </form>
        </Dialogo>
      )}
    </section>
  );
}

// Igual que public.tasa_retencion_honorarios (Ley 21.133)
function retencionPara(f) {
  const a = Number(String(f).slice(0, 4));
  if (a >= 2028) return 17;
  return { 2027: 16, 2026: 15.25, 2025: 14.5, 2024: 13.75, 2023: 13, 2022: 12.25, 2021: 11.5, 2020: 10.75 }[a] ?? 10;
}
