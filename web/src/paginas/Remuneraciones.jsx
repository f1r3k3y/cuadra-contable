import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { csv, fecha, hoy, MESES_LARGOS, peso, rutFormato, rutValido } from '../util';
import { Aviso, CampoMonto, Dialogo, SelectorMes } from '../componentes';

const COLS = [
  ['imponible', 'Imponible', 'Sueldo base, gratificación, horas extra y demás haberes imponibles.'],
  ['no_imponible', 'No imponible', 'Colación, movilización y otros haberes no imponibles.'],
  ['afp', 'AFP', 'Cotización obligatoria + comisión de la AFP, descontada al trabajador.'],
  ['salud', 'Salud', '7 % legal o el plan de la isapre.'],
  ['afc_trabajador', 'Seguro cesantía', 'Aporte del trabajador al seguro de cesantía (0,6 % en contrato indefinido).'],
  ['impuesto_unico', 'Impuesto único', 'Se calcula con la UTM del mes; puede corregirlo.'],
  ['otros_descuentos', 'Otros desc.', 'Anticipos, préstamos u otros descuentos pactados.'],
  ['aporte_empleador', 'Aporte empleador', 'SIS, seguro de cesantía del empleador y mutual: costo de la empresa.'],
];
const filaVacia = () => ({ rut: '', nombre: '', ...Object.fromEntries(COLS.map(([k]) => [k, ''])) });
const n = (v) => Number(v || 0);
const liquido = (l) => n(l.imponible) + n(l.no_imponible) - n(l.afp) - n(l.salud) - n(l.afc_trabajador) - n(l.impuesto_unico) - n(l.otros_descuentos);

// Igual que public.impuesto_unico: tabla mensual en UTM (art. 43 N°1 LIR)
const TRAMOS = [[13.5, 0, 0], [30, 0.04, 0.54], [50, 0.08, 1.74], [70, 0.135, 4.49], [90, 0.23, 11.14], [120, 0.304, 17.8], [310, 0.35, 23.32], [Infinity, 0.4, 38.82]];
export function impuestoUnico(base, utm) {
  if (!(utm > 0) || !(base > 0)) return 0;
  const [, f, r] = TRAMOS.find(([hasta]) => base <= hasta * utm);
  return Math.max(0, Math.round(base * f - r * utm));
}
// Base tributable: imponible menos cotizaciones previsionales del trabajador (salud rebaja hasta el 7 % legal)
const baseTributable = (l) => n(l.imponible) - n(l.afp) - Math.min(n(l.salud), Math.round(n(l.imponible) * 0.07)) - n(l.afc_trabajador);

export default function Remuneraciones() {
  const { empresa, permite } = useEmpresa();
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [rem, setRem] = useState(undefined);
  const [lineas, setLineas] = useState([]);
  const [form, setForm] = useState(null);
  const [cuentas, setCuentas] = useState([]);
  const [anular, setAnular] = useState(null);
  const [msg, setMsg] = useState(null);
  const periodo = mes.replace('-', '');
  const registra = permite('remuneraciones.registrar');

  const cargar = useCallback(async () => {
    const r = await q(sb.from('remuneraciones').select('*, asientos!remuneraciones_asiento_id_fkey(estado, numero)').eq('empresa_id', empresa.id)
      .eq('periodo', periodo).order('creado_en', { ascending: false }));
    const vig = r.find((x) => x.estado === 'vigente') ?? r[0] ?? null;
    setRem(vig);
    setLineas(vig ? await q(sb.from('remuneracion_lineas').select('*').eq('remuneracion_id', vig.id).order('nombre')) : []);
  }, [empresa.id, periodo]);
  useEffect(() => { setForm(null); cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);
  useEffect(() => {
    if (registra) q(sb.from('cuentas').select('id, codigo, nombre, tipo').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true)
      .in('tipo', ['activo', 'pasivo']).order('codigo')).then(setCuentas).catch(() => {});
  }, [empresa.id, registra]);

  async function nuevo(copiar) {
    let filas = [filaVacia()];
    if (copiar) {
      // Copia la nómina del último mes registrado (montos editables)
      const ant = await q(sb.from('remuneraciones').select('id, periodo').eq('empresa_id', empresa.id).eq('estado', 'vigente').lt('periodo', periodo).order('periodo', { ascending: false }).limit(1));
      if (ant.length) {
        const ls = await q(sb.from('remuneracion_lineas').select('*').eq('remuneracion_id', ant[0].id).order('nombre'));
        filas = ls.map((l) => ({ rut: rutFormato(l.rut), nombre: l.nombre, ...Object.fromEntries(COLS.map(([k]) => [k, String(l[k] ?? '')])) }));
      } else setMsg({ t: 'No hay un mes anterior registrado; empiece con una fila vacía.' });
    }
    const [a, m] = mes.split('-');
    const ult = `${mes}-${String(new Date(Number(a), Number(m), 0).getDate()).padStart(2, '0')}`;
    setForm({ fecha: ult > hoy() ? hoy() : ult, utm: '', cuenta: '', filas });
  }

  const setFila = (i, k, v) => setForm({ ...form, filas: form.filas.map((f, j) => (j === i ? { ...f, [k]: v } : f)) });
  const calcularImpuestos = () => setForm({ ...form, filas: form.filas.map((f) => ({ ...f, impuesto_unico: String(impuestoUnico(baseTributable(f), n(form.utm))) })) });

  async function guardar(e) {
    e.preventDefault();
    const malos = form.filas.filter((f) => !rutValido(f.rut));
    if (malos.length) return setForm({ ...form, error: `RUT inválido: ${malos.map((f) => f.rut || '(vacío)').join(', ')}` });
    const negativos = form.filas.filter((f) => liquido(f) < 0);
    if (negativos.length) return setForm({ ...form, error: `El líquido no puede ser negativo: ${negativos.map((f) => f.nombre).join(', ')}` });
    try {
      await rpc('registrar_remuneraciones', {
        p_empresa: empresa.id, p_periodo: periodo, p_fecha: form.fecha, p_utm: form.utm ? n(form.utm) : null,
        p_cuenta_descuentos: form.cuenta || null,
        p_lineas: form.filas.map((f) => ({ rut: f.rut, nombre: f.nombre, ...Object.fromEntries(COLS.map(([k]) => [k, n(f[k])])) })),
      });
      setForm(null);
      setMsg({ ok: true, t: 'Remuneraciones centralizadas: el asiento quedó contabilizado y el impuesto único pasa al F29 (código 48).' });
      cargar();
    } catch (err) { setForm({ ...form, error: err.message }); }
  }

  async function resumenAnual() {
    try {
      const anio = Number(mes.slice(0, 4));
      const r = await rpc('resumen_anual_retenciones', { p_empresa: empresa.id, p_anio: anio });
      if (!r.remuneraciones?.length) return setMsg({ ok: false, t: `No hay remuneraciones registradas en ${anio}.` });
      const filas = [];
      for (const w of r.remuneraciones) for (const d of w.detalle) filas.push({ RUT: rutFormato(w.rut), Nombre: w.nombre, Periodo: `${d.periodo.slice(4)}-${d.periodo.slice(0, 4)}`, RentaTributable: d.renta, ImpuestoUnico: d.impuesto });
      for (const w of r.remuneraciones) filas.push({ RUT: rutFormato(w.rut), Nombre: w.nombre, Periodo: `TOTAL ${anio}`, RentaTributable: w.rentaTributable, ImpuestoUnico: w.impuesto });
      csv(`dj1887_base_${anio}`, filas);
    } catch (e) { setMsg({ ok: false, t: e.message }); }
  }

  async function confirmarAnulacion(e) {
    e.preventDefault();
    try { await rpc('anular_remuneraciones', { p_id: rem.id, p_motivo: anular.motivo }); setAnular(null); setMsg({ ok: true, t: 'Remuneraciones anuladas; puede registrarlas de nuevo.' }); cargar(); }
    catch (err) { setAnular({ ...anular, error: err.message }); }
  }

  const totales = (ls) => Object.fromEntries([...COLS.map(([k]) => [k, ls.reduce((s, l) => s + n(l[k]), 0)]), ['liquido', ls.reduce((s, l) => s + liquido(l), 0)]]);
  const t = totales(form ? form.filas : lineas);
  const [a, m] = mes.split('-');

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Remuneraciones · {MESES_LARGOS[Number(m) - 1]} {a}</h1>
          <p className="chico">Libro mensual y centralización contable. El impuesto único va al F29 (código 48); las cotizaciones quedan en Leyes sociales por pagar hasta pagarlas en Previred.</p>
        </div>
        <div className="filtros"><SelectorMes valor={mes} alCambiar={setMes} />
          <button onClick={resumenAnual} title="Renta tributable e impuesto único por trabajador: base para la Declaración Jurada 1887">Resumen anual {mes.slice(0, 4)} (DJ 1887)</button></div>
      </header>
      <Aviso msg={msg} />

      {rem === undefined ? <p>Cargando…</p> : form ? (
        <form className="formulario" onSubmit={guardar}>
          <div className="rejilla">
            <label>Fecha de centralización<input type="date" min={`${mes}-01`} max={hoy()} value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} required /></label>
            <label data-ayuda="Valor de la UTM del mes (sii.cl › Valores y fechas). Se usa para calcular el impuesto único.">UTM del mes<CampoMonto valor={form.utm} alCambiar={(v) => setForm({ ...form, utm: v })} /></label>
            <label>Cuenta de otros descuentos<select value={form.cuenta} onChange={(e) => setForm({ ...form, cuenta: e.target.value })}>
              <option value="">— (sin otros descuentos)</option>
              {cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
            </select></label>
          </div>
          <div className="scroll">
            <table className="tabla tabla-edicion">
              <thead><tr><th>RUT</th><th>Nombre</th>{COLS.map(([k, tt, ay]) => <th key={k} className="n" data-ayuda={ay}>{tt}</th>)}<th className="n">Líquido</th><th></th></tr></thead>
              <tbody>
                {form.filas.map((f, i) => (
                  <tr key={i}>
                    <td><input aria-label="RUT" value={f.rut} onChange={(e) => setFila(i, 'rut', e.target.value)} onBlur={() => setFila(i, 'rut', rutFormato(f.rut))} required size={12} /></td>
                    <td><input aria-label="Nombre" value={f.nombre} onChange={(e) => setFila(i, 'nombre', e.target.value)} required maxLength={120} /></td>
                    {COLS.map(([k, tt]) => <td key={k}><CampoMonto aria-label={tt} valor={f[k]} alCambiar={(v) => setFila(i, k, v)} /></td>)}
                    <td className={'n' + (liquido(f) < 0 ? ' error-texto' : '')}>{peso(liquido(f))}</td>
                    <td>{form.filas.length > 1 && <button type="button" className="enlace" onClick={() => setForm({ ...form, filas: form.filas.filter((_, j) => j !== i) })}>Quitar</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2}>Totales</td>{COLS.map(([k]) => <td key={k} className="n">{peso(t[k])}</td>)}<td className="n">{peso(t.liquido)}</td><td></td></tr></tfoot>
            </table>
          </div>
          <div className="acciones izquierda">
            <button type="button" onClick={() => setForm({ ...form, filas: [...form.filas, filaVacia()] })}>+ Agregar trabajador</button>
            <button type="button" onClick={calcularImpuestos} disabled={!n(form.utm)} title={n(form.utm) ? '' : 'Ingrese la UTM del mes'}>Calcular impuesto único</button>
          </div>
          <p className="chico">Costo de la empresa: <b>{peso(t.imponible + t.no_imponible + t.aporte_empleador)}</b> · Leyes sociales por pagar: <b>{peso(t.afp + t.salud + t.afc_trabajador + t.aporte_empleador)}</b> · Impuesto único: <b>{peso(t.impuesto_unico)}</b>.
            El cálculo del impuesto no aplica topes imponibles ni rebajas especiales: revise contra su liquidación.</p>
          {form.error && <p className="aviso error">{form.error}</p>}
          <div className="acciones"><button type="button" onClick={() => setForm(null)}>Cancelar</button><button className="primario">Centralizar mes</button></div>
        </form>
      ) : !rem || rem.estado === 'anulada' ? (
        <div className="vacio-grande">
          <p>{rem?.estado === 'anulada' ? `Las remuneraciones del mes se anularon (${rem.motivo_anulacion}).` : 'Aún no hay remuneraciones registradas para este mes.'}</p>
          {registra && <div className="acciones izquierda"><button className="primario" onClick={() => nuevo(true)}>Copiar nómina del mes anterior</button><button onClick={() => nuevo(false)}>Empezar en blanco</button></div>}
        </div>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi"><span>Costo empresa</span><b>{peso(t.imponible + t.no_imponible + t.aporte_empleador)}</b></div>
            <div className="kpi"><span>Líquido a pagar</span><b>{peso(t.liquido)}</b></div>
            <div className="kpi"><span>Leyes sociales</span><b>{peso(t.afp + t.salud + t.afc_trabajador + t.aporte_empleador)}</b></div>
            <div className="kpi"><span>Impuesto único (F29 48)</span><b>{peso(t.impuesto_unico)}</b></div>
          </div>
          <p className="chico">Centralizado el {fecha(rem.fecha)}{rem.utm ? ` · UTM ${peso(rem.utm)}` : ''} · asiento {rem.asientos?.numero ?? '—'}
            {rem.asientos && <> <span className={'etiqueta ' + (rem.asientos.estado === 'contabilizado' ? 'contabilizado' : 'borrador')}>{rem.asientos.estado === 'contabilizado' ? 'Contabilizado' : 'Por aprobar'}</span></>}
            {' '}{rem.pagado_en ? <span className="etiqueta contabilizado">Sueldos pagados el {fecha(rem.pagado_en)}</span> : <span className="etiqueta borrador">Sueldos por pagar (Tesorería)</span>}</p>
          <div className="scroll">
            <table className="tabla">
              <thead><tr><th>RUT</th><th>Nombre</th>{COLS.map(([k, tt]) => <th key={k} className="n">{tt}</th>)}<th className="n">Líquido</th></tr></thead>
              <tbody>{lineas.map((l) => <tr key={l.id}><td className="nw">{rutFormato(l.rut)}</td><td>{l.nombre}</td>{COLS.map(([k]) => <td key={k} className="n">{peso(l[k])}</td>)}<td className="n">{peso(l.liquido)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={2}>Totales</td>{COLS.map(([k]) => <td key={k} className="n">{peso(t[k])}</td>)}<td className="n">{peso(t.liquido)}</td></tr></tfoot>
            </table>
          </div>
          <div className="acciones izquierda">
            <button onClick={() => csv(`remuneraciones_${periodo}`, lineas.map((l) => ({ RUT: rutFormato(l.rut), Nombre: l.nombre, ...Object.fromEntries(COLS.map(([k, tt]) => [tt, l[k]])), Liquido: l.liquido })))}>Descargar CSV</button>
            <button title="Montos por trabajador para declarar y pagar en Previred. No es el archivo de carga masiva de Previred." onClick={() => csv(`cotizaciones_previred_${periodo}`, lineas.map((l) => ({
              RUT: rutFormato(l.rut), Nombre: l.nombre, RentaImponible: l.imponible, CotizacionAFP: l.afp, Salud: l.salud, SeguroCesantiaTrabajador: l.afc_trabajador,
              AportesEmpleador: l.aporte_empleador, TotalAPagar: Number(l.afp) + Number(l.salud) + Number(l.afc_trabajador) + Number(l.aporte_empleador) })))}>Resumen para Previred (CSV)</button>
            {registra && <button onClick={() => setAnular({ motivo: '' })}>Anular para corregir</button>}
          </div>
        </>
      )}

      {anular && (
        <Dialogo titulo="Anular remuneraciones" alCerrar={() => setAnular(null)}>
          <form onSubmit={confirmarAnulacion}>
            <h2>Anular remuneraciones del mes</h2>
            <p>Se anula (o reversa) la centralización y puede volver a registrarlas. Si los sueldos ya se pagaron, anule primero ese pago en Asientos.</p>
            <label>Motivo<input value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} minLength={5} required autoFocus /></label>
            {anular.error && <p className="aviso error">{anular.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAnular(null)}>Cancelar</button><button className="peligro">Anular</button></div>
          </form>
        </Dialogo>
      )}
    </section>
  );
}
